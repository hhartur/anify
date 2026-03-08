// ============================================================
// config.js — Configuração central da API
//
// Lê API_BASE_URL do .env (ou variável de ambiente).
// Para mudar de localhost para produção, basta alterar o .env:
//   API_BASE_URL=https://minha-api.exemplo.com
// ============================================================

// Carrega .env se existir (sem depender de dotenv — Bun suporta nativamente)
// Se estiver usando Node.js puro, instale dotenv e descomente a linha abaixo:
import { configDotenv } from "dotenv";
configDotenv()

export const API_BASE_URL =
  process.env.API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";

export const PORT = parseInt(process.env.PORT) || 3000;