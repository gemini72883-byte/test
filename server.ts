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

type Job = {
  logs: string[];
  done: boolean;
  failed: boolean;
  artifact: string | null;
};

const jobs = new Map<string, Job>();

app.post("/compile", upload.single("project"), async (req, res) => {
  if (!req.file) return res.status(400).send("Missing project zip");
  if (!req.body.entry) return res.status(400).send("Missing entry file");

  const id = crypto.randomUUID();
  const entry = req.body.entry;

  const workdir = `/tmp/job-${id}`;
  const outdir = `${workdir}/dist`;

  fs.mkdirSync(workdir, { recursive: true });

  await fs.createReadStream(req.file.path)
    .pipe(unzipper.Extract({ path: workdir }))
    .promise();

  jobs.set(id, {
    logs: [],
    done: false,
    failed: false,
    artifact: null
  });

  const job = jobs.get(id)!;

  const child = spawn("python", [
    "-m",
    "nuitka",
    "--standalone",
    "--onefile",
    "--jobs=1",
    `--output-dir=${outdir}`,
    entry
  ], {
    cwd: workdir,
    shell: false,
    env: {
      ...process.env,
      CFLAGS: "-O0",
      CXXFLAGS: "-O0"
    }
  });

  child.stdout.on("data", d => job.logs.push(d.toString()));
  child.stderr.on("data", d => job.logs.push(d.toString()));

  child.on("close", async code => {
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
      job.logs.push("\n[DONE]\n");
    } else {
      job.logs.push("\n[FAILED]\n");
    }
  });

  res.json({ jobId: id });
});

app.get("/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) return res.status(404).send("Job not found");
  if (!job.done) return res.status(400).send("Still compiling");
  if (job.failed) return res.status(500).send("Compilation failed");
  if (!job.artifact) return res.status(404).send("Artifact missing");

  res.download(job.artifact, "compiled-result.zip");
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const id = req.url?.split("/").pop();
  if (!id) return ws.close();

  const interval = setInterval(() => {
    const job = jobs.get(id);

    if (!job) {
      ws.send("Job not found");
      clearInterval(interval);
      return ws.close();
    }

    while (job.logs.length) {
      ws.send(job.logs.shift()!);
    }

    if (job.done) {
      clearInterval(interval);
      ws.close();
    }
  }, 300);
});
