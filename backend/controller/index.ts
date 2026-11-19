import "dotenv/config";
import express from "express";
import cors from "cors";
import { registerRepo, listReposForPat, getRepo, deleteRepo, verifyRepo } from "./repos";

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

app.listen(PORT, () => console.log(`controller API on http://localhost:${PORT}`));
