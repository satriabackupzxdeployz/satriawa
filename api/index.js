import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

const fConfig = {
  apiKey: "AIzaSyA6z5xdJPyyI1he92gj84MYy12a18xh0kE",
  authDomain: "sapp-bec48.firebaseapp.com",
  projectId: "sapp-bec48",
  storageBucket: "sapp-bec48.firebasestorage.app",
  messagingSenderId: "799271457706",
  appId: "1:799271457706:web:f48650c046bc47bfecd1d3"
};

app.get('/api/config', (req, res) => {
  res.json(fConfig);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});