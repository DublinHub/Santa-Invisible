const nodemailer = require("nodemailer");
// server.js
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const path = require("path");
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "ceciidemalde@gmail.com",
    pass: "hope uwio tktf gwpy"
  }
});

const app = express();
app.use(cors());
app.use(express.json());

// DB setup
const db = new Database("santa.db");

// Crear tablas si no existen
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    deadline TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    adminCode TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eventId INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    wishlist TEXT,
    FOREIGN KEY (eventId) REFERENCES events(id)
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eventId INTEGER NOT NULL,
    giverId INTEGER NOT NULL,
    receiverId INTEGER NOT NULL,
    FOREIGN KEY (eventId) REFERENCES events(id),
    FOREIGN KEY (giverId) REFERENCES participants(id),
    FOREIGN KEY (receiverId) REFERENCES participants(id)
  );
`);

// Helper: generar slug simple
function generateSlug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const random = Math.random().toString(36).slice(2, 6);
  return `${base}-${random}`;
}

// Helper: generar código admin
function generateAdminCode() {
  return crypto.randomBytes(3).toString("hex"); // ej "a3f9c2"
}

// Helper: algoritmo de sorteo (sin auto-regalos)
function hacerSorteo(participants) {
  if (participants.length < 2) {
    throw new Error("Se necesitan al menos 2 participantes para el sorteo.");
  }

  const ids = participants.map(p => p.id);
  let asignaciones = null;

  for (let intento = 0; intento < 1000; intento++) {
    // Clonar y mezclar
    const receptores = [...ids];
    for (let i = receptores.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [receptores[i], receptores[j]] = [receptores[j], receptores[i]];
    }

    // Revisar que nadie se regale a sí mismo
    let valido = true;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === receptores[i]) {
        valido = false;
        break;
      }
    }

    if (valido) {
      asignaciones = ids.map((giverId, i) => ({
        giverId,
        receiverId: receptores[i],
      }));
      break;
    }
  }

  if (!asignaciones) {
    throw new Error("No se pudo generar un sorteo válido, intenta de nuevo.");
  }

  return asignaciones;
}

// Crear evento
app.post("/api/events", (req, res) => {
  const { name, description, deadline } = req.body;

  if (!name || !deadline) {
    return res.status(400).json({ error: "name y deadline son obligatorios" });
  }

  const slug = generateSlug(name);
  const adminCode = generateAdminCode();

  const stmt = db.prepare(`
    INSERT INTO events (name, slug, description, deadline, status, adminCode)
    VALUES (?, ?, ?, ?, 'open', ?)
  `);
  const info = stmt.run(name, slug, description || "", deadline, adminCode);

  res.json({
    id: info.lastInsertRowid,
    name,
    slug,
    description: description || "",
    deadline,
    status: "open",
    adminCode,
    publicUrl: `/evento/${slug}`,
  });
});

// Obtener evento por slug
app.get("/api/events/:slug", (req, res) => {
  const { slug } = req.params;
  const stmt = db.prepare("SELECT id, name, slug, description, deadline, status FROM events WHERE slug = ?");
  const event = stmt.get(slug);

  if (!event) {
    return res.status(404).json({ error: "Evento no encontrado" });
  }

  res.json(event);
});

// Agregar participante
app.post("/api/events/:slug/participants", (req, res) => {
  const { slug } = req.params;
  const { name, email, phone, wishlist } = req.body;

  const eventStmt = db.prepare("SELECT * FROM events WHERE slug = ?");
  const event = eventStmt.get(slug);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  if (event.status !== "open") {
    return res.status(400).json({ error: "El evento ya no acepta participantes" });
  }

  const now = new Date();
  const deadline = new Date(event.deadline);
  if (now > deadline) {
    return res.status(400).json({ error: "La fecha límite ya pasó" });
  }

  const insert = db.prepare(`
    INSERT INTO participants (eventId, name, email, phone, wishlist)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = insert.run(event.id, name, email, phone || "", wishlist || "");

  res.json({
    id: info.lastInsertRowid,
    eventId: event.id,
    name,
    email,
    phone: phone || "",
    wishlist: wishlist || "",
  });
});

// Listar participantes (vista admin simple)
app.get("/api/events/:slug/participants", (req, res) => {
  const { slug } = req.params;
  const eventStmt = db.prepare("SELECT * FROM events WHERE slug = ?");
  const event = eventStmt.get(slug);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  const participants = db.prepare("SELECT * FROM participants WHERE eventId = ?").all(event.id);
  res.json(participants);
});

// Hacer sorteo (admin)
app.post("/api/events/:slug/draw", (req, res) => {
  const { slug } = req.params;
  const { adminCode } = req.body;

  const eventStmt = db.prepare("SELECT * FROM events WHERE slug = ?");
  const event = eventStmt.get(slug);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  if (event.adminCode !== adminCode) {
    return res.status(403).json({ error: "Código de administradora incorrecto" });
  }

  if (event.status === "drawn") {
    return res.status(400).json({ error: "El sorteo ya fue realizado" });
  }

  const participants = db.prepare("SELECT * FROM participants WHERE eventId = ?").all(event.id);
  const asignaciones = hacerSorteo(participants);

  const insert = db.prepare(`
    INSERT INTO assignments (eventId, giverId, receiverId)
    VALUES (?, ?, ?)
  `);

const transaction = db.transaction(() => {
  asignaciones.forEach(a => {
    insert.run(event.id, a.giverId, a.receiverId);
  });
  db.prepare("UPDATE events SET status = 'drawn' WHERE id = ?").run(event.id);
});

transaction();

// Enviar mails privados a cada participante
asignaciones.forEach(a => {
  const giver = participants.find(p => p.id === a.giverId);
  const receiver = participants.find(p => p.id === a.receiverId);

  transporter.sendMail({
    from: `"Santa Invisible 🎅" <${process.env.MAIL_USER}>`,
    to: giver.email,
    subject: "🎁 Tu Santa Invisible",
    html: `
      <h2>🎅 Santa Invisible Familiar</h2>
      <p>Hola <b>${giver.name}</b>,</p>
      <p>Te tocó regalarle a:</p>
      <h3>${receiver.name}</h3>
      <p><b>Lista de regalos:</b></p>
      <p>${receiver.wishlist || "No cargó lista de regalos."}</p>
      <br>
      <p>🎄 ¡Felices fiestas!</p>
    `
  });
});

res.json({ message: "Sorteo realizado con éxito y mails enviados", total: asignaciones.length });


});

// Ver mis resultados (para un participante, por email)
app.post("/api/events/:slug/my-assignment", (req, res) => {
  const { slug } = req.params;
  const { email } = req.body;

  const eventStmt = db.prepare("SELECT * FROM events WHERE slug = ?");
  const event = eventStmt.get(slug);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });

  if (event.status !== "drawn") {
    return res.status(400).json({ error: "El sorteo aún no se realizó" });
  }

  const participant = db.prepare(
    "SELECT * FROM participants WHERE eventId = ? AND email = ?"
  ).get(event.id, email);

  if (!participant) {
    return res.status(404).json({ error: "No se encontró un participante con ese email" });
  }

  const assignment = db.prepare(
    "SELECT receiverId FROM assignments WHERE eventId = ? AND giverId = ?"
  ).get(event.id, participant.id);

  if (!assignment) {
    return res.status(404).json({ error: "No se encontró tu asignación" });
  }

  const receiver = db.prepare("SELECT * FROM participants WHERE id = ?").get(assignment.receiverId);

res.json({
    you: participant.name,
    receiverName: receiver.name,
    receiverWishlist: receiver.wishlist,
});
});   // ← esta cierra la función interna
});   // 💥 ← ESTA es la que te faltaba: cierra el endpoint completo


// Servir frontend estático (si lo ponés en /public)
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Santa Invisible app escuchando en puerto ${PORT}`);
});



