// chat-backend/index.js - VERSÃO FINAL, COMPLETA E VERIFICADA

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const JWT_SECRET = 'minha-chave-super-secreta-12345';
const onlineUsers = {};

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "http://localhost:3000", methods: ["GET", "POST"] } });

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Autenticação falhou: Token não fornecido.'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user) return next(new Error('Autenticação falhou: Utilizador não encontrado.'));
    socket.user = user;
    next();
  } catch (err) {
    return next(new Error('Autenticação falhou: Token inválido.'));
  }
});

io.on('connection', async (socket) => {
  console.log(`O usuário '${socket.user.username}' (ID: ${socket.id}) se conectou.`);

  onlineUsers[socket.user.id] = { id: socket.user.id, username: socket.user.username, socketId: socket.id, avatarUrl: socket.user.avatarUrl };
  io.emit('onlineUsers', Object.values(onlineUsers));

  const allPublicRooms = await prisma.room.findMany({ where: { NOT: { name: { startsWith: 'dm-' } } } });
  const roomNames = allPublicRooms.map(r => r.name);
  socket.emit('availableRooms', roomNames);

  const defaultRoom = allPublicRooms.find(r => r.name === '#geral');
  if (defaultRoom) {
    socket.join(defaultRoom.name);
    socket.currentRoom = { id: defaultRoom.id, name: defaultRoom.name };
    const historyFromDb = await prisma.message.findMany({ where: { roomId: defaultRoom.id }, include: { author: true }, orderBy: { createdAt: 'asc' } });
    const historyForFrontend = historyFromDb.map(msg => ({ ...msg, user: msg.author, roomName: defaultRoom.name }));
    socket.emit('messageHistory', historyForFrontend);
  }

  socket.on('get_dm_conversations', async () => {
    try {
      const userId = socket.user.id;
      const dmRooms = await prisma.room.findMany({ where: { AND: [{ name: { startsWith: 'dm-' } }, { name: { contains: `-${userId}-` } }] } });
      const otherUserIds = dmRooms.map(room => { const ids = room.name.split('-').slice(1); return ids.find(id => parseInt(id, 10) !== userId); }).map(id => parseInt(id, 10));
      if (otherUserIds.length > 0) {
        const otherUsers = await prisma.user.findMany({ where: { id: { in: otherUserIds } } });
        const conversations = dmRooms.map(room => {
          const otherId = parseInt(room.name.split('-').slice(1).find(id => parseInt(id, 10) !== userId), 10);
          const otherUser = otherUsers.find(u => u.id === otherId);
          return { roomName: room.name, otherUser: otherUser };
        }).filter(conv => conv.otherUser);
        socket.emit('dm_conversations_list', conversations);
      } else {
        socket.emit('dm_conversations_list', []);
      }
    } catch (error) { console.error("Erro ao buscar DMs:", error); socket.emit('dm_conversations_list', []); }
  });

  socket.on('joinRoom', async (roomName) => {
    const room = await prisma.room.findUnique({ where: { name: roomName } });
    if (room && socket.currentRoom?.name !== room.name) {
      if (socket.currentRoom) socket.leave(socket.currentRoom.name);
      socket.join(room.name);
      socket.currentRoom = { id: room.id, name: room.name };
      socket.emit('roomJoined', room.name);
      const historyFromDb = await prisma.message.findMany({ where: { roomId: room.id }, include: { author: true }, orderBy: { createdAt: 'asc' } });
      const historyForFrontend = historyFromDb.map(msg => ({ ...msg, user: msg.author, roomName: room.name }));
      socket.emit('messageHistory', historyForFrontend);
    }
  });

  socket.on('start_dm', async (targetUserId) => {
    const targetUser = onlineUsers[targetUserId];
    if (!targetUser) return;
    const userIds = [socket.user.id, targetUserId].sort();
    const roomName = `dm-${userIds[0]}-${userIds[1]}`;
    let room = await prisma.room.findUnique({ where: { name: roomName } });
    if (!room) room = await prisma.room.create({ data: { name: roomName } });
    if (socket.currentRoom) socket.leave(socket.currentRoom.name);
    socket.join(room.name);
    socket.currentRoom = { id: room.id, name: room.name };
    const targetSocket = io.sockets.sockets.get(targetUser.socketId);
    if (targetSocket) {
      if (targetSocket.currentRoom) targetSocket.leave(targetSocket.currentRoom.name);
      targetSocket.join(room.name);
      targetSocket.currentRoom = { id: room.id, name: room.name };
    }
    const dmUsers = [socket.user, { id: targetUser.id, username: targetUser.username, avatarUrl: targetUser.avatarUrl }];
    io.to(room.name).emit('dm_started', { roomName, users: dmUsers });
    const historyFromDb = await prisma.message.findMany({ where: { roomId: room.id }, include: { author: true }, orderBy: { createdAt: 'asc' } });
    const historyForFrontend = historyFromDb.map(msg => ({ ...msg, user: msg.author, roomName: room.name }));
    io.to(room.name).emit('messageHistory', historyForFrontend);
  });

  socket.on('sendMessage', async (messageText) => {
    if (typeof messageText !== 'string' || messageText.trim() === '' || !socket.currentRoom) return;
    const newMessage = await prisma.message.create({
      data: { text: messageText, authorId: socket.user.id, roomId: socket.currentRoom.id },
      include: { author: true }
    });
    const messagePayload = { ...newMessage, user: newMessage.author, socketId: socket.id, roomName: socket.currentRoom.name };
    io.to(socket.currentRoom.name).emit('receiveMessage', messagePayload);
  });

  socket.on('typing', () => { if (socket.currentRoom) socket.broadcast.to(socket.currentRoom.name).emit('userTyping', socket.user); });
  socket.on('stopTyping', () => { if (socket.currentRoom) socket.broadcast.to(socket.currentRoom.name).emit('userStoppedTyping', socket.user); });

  socket.on('disconnect', () => {
    console.log(`O usuário '${socket.user.username}' se desconectou.`);
    if (socket.currentRoom) {
      socket.broadcast.to(socket.currentRoom.name).emit('userStoppedTyping', socket.user);
    }
    delete onlineUsers[socket.user.id];
    io.emit('onlineUsers', Object.values(onlineUsers));
  });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Nome de utilizador e senha são obrigatórios.' });
  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ message: 'Credenciais inválidas' });
    const isPasswordValid = bcrypt.compareSync(password, user.password);
    if (!isPasswordValid) return res.status(401).json({ message: 'Credenciais inválidas' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (error) {
    console.error("Erro no login:", error);
    res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

async function seedDatabase() {
  console.log("A verificar e a popular o banco de dados...");
  await prisma.room.upsert({ where: { name: '#geral' }, update: {}, create: { name: '#geral' } });
  await prisma.room.upsert({ where: { name: '#projetos' }, update: {}, create: { name: '#projetos' } });
  await prisma.room.upsert({ where: { name: '#jogos' }, update: {}, create: { name: '#jogos' } });
  const salt = bcrypt.genSaltSync(10);
  const passwordAna = bcrypt.hashSync('123', salt);
  const passwordJoao = bcrypt.hashSync('456', salt);
  await prisma.user.upsert({ where: { username: 'ana' }, update: { avatarUrl: 'https://i.pravatar.cc/150?u=ana' }, create: { username: 'ana', password: passwordAna, avatarUrl: 'https://i.pravatar.cc/150?u=ana' } });
  await prisma.user.upsert({ where: { username: 'joao' }, update: { avatarUrl: 'https://i.pravatar.cc/150?u=joao' }, create: { username: 'joao', password: passwordJoao, avatarUrl: 'https://i.pravatar.cc/150?u=joao' } });
  console.log("Banco de dados pronto.");
}

async function startServer() {
  try {
    await seedDatabase();
  } catch (e) {
    console.error("Erro durante o seeding do banco de dados", e);
    process.exit(1);
  }
  server.listen(3001, () => {
    console.log(`Servidor escutando na porta 3001`);
  });
}

startServer();