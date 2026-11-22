import "dotenv/config";
import express from "express";
import cors from "cors";
import { registerRepo, listReposForPat, getRepo, deleteRepo, verifyRepo } from "./repos";
import { createSession, listMessages, createMessage } from "./sessions";
import { startCron } from "./cron";
import { startWs } from "./ws";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use(cors());

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/api/repos", registerRepo);
app.post("/api/repos/accessible", listReposForPat);
app.get("/api/repos/:id", getRepo);
app.delete("/api/repos/:id", deleteRepo);
app.post("/api/repos/:id/verify", verifyRepo);

app.post("/api/repos/:repoId/sessions", createSession);
app.get("/api/repos/:repoId/sessions/:sessionId/messages", listMessages);
app.post("/api/repos/:repoId/sessions/:sessionId/messages", createMessage);

startCron();
startWs(Number(process.env.WS_PORT ?? 8080));

app.listen(PORT, () => console.log(`controller API on http://localhost:${PORT}`));
