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
const upload = multer({
  dest: "/tmp/uploads",
  limits: {
    fileSize: 200 * 1024 * 1024
  }
});

type Job = {
  id: string;
  logs: string[];
  done: boolean;
  failed: boolean;
  artifact: string | null;
  exitCode: number | null;
};

const jobs = new Map<string, Job>();

function safeEntry(entry: string) {
  if (entry.includes("..")) throw new Error("Invalid entry path");
  if (entry.startsWith("/")) throw new Error("Invalid entry path");
  if (!entry.endsWith(".py")) throw new Error("Entry must be a .py file");
  return entry;
}

async function zipDirectory(sourceDir: string, outputZip: string) {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputZip);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => resolve());
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

app.post("/compile", upload.single("project"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("Missing project zip");
    if (!req.body.entry) return res.status(400).send("Missing entry file");

    const id = crypto.randomUUID();
    const entry = safeEntry(req.body.entry);
    const mode = req.body.mode === "onefile" ? "onefile" : "standalone";

    const workdir = `/tmp/job-${id}`;
    const outdir = `${workdir}/out`;
    const artifact = `/tmp/${id}-compiled-result.zip`;

    fs.mkdirSync(workdir, { recursive: true });
    fs.mkdirSync(outdir, { recursive: true });

    const job: Job = {
      id,
      logs: [],
      done: false,
      failed: false,
      artifact: null,
      exitCode: null
    };

    jobs.set(id, job);

    job.logs.push(`[JOB ${id}]\n`);
    job.logs.push(`[MODE ${mode}]\n`);
    job.logs.push(`[ENTRY ${entry}]\n`);
    job.logs.push("[EXTRACTING ZIP]\n");

    await fs.createReadStream(req.file.path)
      .pipe(unzipper.Extract({ path: workdir }))
      .promise();

    const entryPath = path.join(workdir, entry);

    if (!fs.existsSync(entryPath)) {
      job.done = true;
      job.failed = true;
      job.logs.push(`[ERROR] Entry file not found: ${entry}\n`);
      return res.json({ jobId: id });
    }

    const nuitkaArgs = [
      "-m",
      "nuitka",
      "--standalone",
      "--jobs=1",
      "--remove-output",
      `--output-dir=${outdir}`
    ];

    if (mode === "onefile") {
      nuitkaArgs.push("--onefile");
      nuitkaArgs.push("--onefile-no-compression");
    }

    nuitkaArgs.push(entry);

    job.logs.push(`[RUNNING] python ${nuitkaArgs.join(" ")}\n\n`);

    const child = spawn("python", nuitkaArgs, {
      cwd: workdir,
      shell: false,
      env: {
        ...process.env,
        CFLAGS: "-O0",
        CXXFLAGS: "-O0",
        CCACHE_DIR: "/tmp/ccache"
      }
    });

    child.stdout.on("data", d => job.logs.push(d.toString()));
    child.stderr.on("data", d => job.logs.push(d.toString()));

    child.on("error", err => {
      job.logs.push(`\n[SPAWN ERROR] ${err.message}\n`);
      job.done = true;
      job.failed = true;
    });

    child.on("close", async code => {
      job.exitCode = code;

      try {
        if (code !== 0) {
          job.failed = true;
          job.logs.push(`\n[FAILED] Nuitka exited with code ${code}\n`);
        } else {
          job.logs.push("\n[ZIPPING ARTIFACT]\n");
          await zipDirectory(outdir, artifact);
          job.artifact = artifact;
          job.logs.push("\n[DONE]\n");
        }
      } catch (err: any) {
        job.failed = true;
        job.logs.push(`\n[ZIP ERROR] ${err.message}\n`);
      }

      job.done = true;
    });

    res.json({ jobId: id, mode, logs: `wss://${req.hostname}/${id}`, download: `/download/${id}` });
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

app.get("/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("Job not found");

  res.json({
    id: job.id,
    done: job.done,
    failed: job.failed,
    exitCode: job.exitCode,
    hasArtifact: !!job.artifact
  });
});

app.get("/logs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("Job not found");

  res.type("text/plain").send(job.logs.join(""));
});

app.get("/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) return res.status(404).send("Job not found");
  if (!job.done) return res.status(400).send("Still compiling");
  if (job.failed) return res.status(500).send("Compilation failed. Check logs.");
  if (!job.artifact) return res.status(404).send("Artifact missing");

  res.download(job.artifact, "compiled-result.zip");
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const id = req.url?.split("/").filter(Boolean).pop();
  if (!id) return ws.close();

  let cursor = 0;

  const interval = setInterval(() => {
    const job = jobs.get(id);

    if (!job) {
      ws.send("Job not found\n");
      clearInterval(interval);
      return ws.close();
    }

    while (cursor < job.logs.length) {
      ws.send(job.logs[cursor]);
      cursor++;
    }

    if (job.done) {
      clearInterval(interval);
      ws.close();
    }
  }, 300);
});
