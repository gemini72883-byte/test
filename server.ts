import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import archiver from "archiver";
import { spawn } from "child_process";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const upload = multer({ dest: "/tmp/uploads" });
const jobs = new Map<string, any>();

app.post("/compile", upload.single("project"), async (req, res) => {
  const entry = req.body.entry;
  const id = crypto.randomUUID();

  const workdir = `/tmp/job-${id}`;
  const outdir = `${workdir}/dist`;

  fs.mkdirSync(workdir, { recursive: true });

  await fs.createReadStream(req.file!.path)
    .pipe(unzipper.Extract({ path: workdir }))
    .promise();

  jobs.set(id, {
    logs: [],
    done: false,
    failed: false,
    artifact: null
  });

  const child = spawn("python", [
    "-m", "nuitka",
    "--standalone",
    "--onefile",
    `--output-dir=${outdir}`,
    entry
  ], {
    cwd: workdir,
    shell: false
  });

  child.stdout.on("data", d => jobs.get(id).logs.push(d.toString()));
  child.stderr.on("data", d => jobs.get(id).logs.push(d.toString()));

  child.on("close", async code => {
    const job = jobs.get(id);
    job.done = true;
    job.failed = code !== 0;

    if (code === 0) {
      const zipPath = `/tmp/${id}-result.zip`;
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip");

      archive.pipe(output);
      archive.directory(outdir, false);
      await archive.finalize();

      job.artifact = zipPath;
    }
  });

  res.json({ jobId: id });
});

app.get("/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) return res.status(404).send("Job not found");
  if (!job.done) return res.status(400).send("Still compiling");
  if (job.failed) return res.status(500).send("Compilation failed");

  res.download(job.artifact, "compiled-result.zip");
});

const server = app.listen(process.env.PORT || 3000);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const id = req.url?.split("/").pop();
  if (!id) return ws.close();

  const interval = setInterval(() => {
    const job = jobs.get(id);
    if (!job) return;

    while (job.logs.length) {
      ws.send(job.logs.shift());
    }

    if (job.done) {
      ws.send(job.failed ? "\n[FAILED]" : "\n[DONE]");
      clearInterval(interval);
      ws.close();
    }
  }, 300);
});