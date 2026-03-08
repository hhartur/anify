import app from "../api.js";

let ready = false;

export default async function handler(req, res) {
  if (!ready) {
    await app.ready();
    ready = true;
  }

  app.server.emit("request", req, res);
}