import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import { spawn } from "child_process";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver = require("archiver");

const app = express();

const upload = multer({
  dest: "/tmp/uploads",
  limits: {
    fileSize: 300 * 1024 * 1024
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

function log(job: Job, msg: string) {
  job.logs.push(msg.endsWith("\n") ? msg : msg + "\n");
}

function safeEntry(entry: string) {
  entry = entry.trim();

  if (!entry) throw new Error("Missing entry");
  if (!entry.endsWith(".py")) throw new Error("Entry must be a .py file");
  if (entry.includes("..")) throw new Error("Entry cannot contain ..");
  if (path.isAbsolute(entry)) throw new Error("Entry cannot be absolute path");

  return entry;
}

async function zipDirectory(sourceDir: string, outputZip: string) {
  return new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputZip);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

app.post("/compile", upload.single("project"), async (req, res) => {
  let job: Job | null = null;

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

    job = {
      id,
      logs: [],
      done: false,
      failed: false,
      artifact: null,
      exitCode: null
    };

    jobs.set(id, job);

    log(job, `[JOB] ${id}`);
    log(job, `[MODE] ${mode}`);
    log(job, `[ENTRY] ${entry}`);
    log(job, "[EXTRACTING ZIP]");

    await fs.createReadStream(req.file.path)
      .pipe(unzipper.Extract({ path: workdir }))
      .promise();

    fs.rmSync(req.file.path, { force: true });

    const entryPath = path.join(workdir, entry);

    if (!fs.existsSync(entryPath)) {
      job.done = true;
      job.failed = true;
      log(job, `[ERROR] Entry file not found: ${entry}`);
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

    log(job, `[RUNNING] python ${nuitkaArgs.join(" ")}`);

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

    child.stdout.on("data", d => log(job!, d.toString()));
    child.stderr.on("data", d => log(job!, d.toString()));

    child.on("error", err => {
      job!.failed = true;
      job!.done = true;
      log(job!, `[SPAWN ERROR] ${err.message}`);
    });

    child.on("close", async code => {
      job!.exitCode = code;

      try {
        if (code !== 0) {
          job!.failed = true;
          log(job!, `[FAILED] Nuitka exited with code ${code}`);
        } else {
          log(job!, "[ZIPPING ARTIFACT]");
          await zipDirectory(outdir, artifact);
          job!.artifact = artifact;
          log(job!, "[DONE]");
        }
      } catch (err: any) {
        job!.failed = true;
        log(job!, `[ZIP ERROR] ${err.message}`);
      }

      job!.done = true;
    });

    return res.json({
      jobId: id,
      mode,
      logs: `wss://${req.hostname}/${id}`,
      status: `/status/${id}`,
      download: `/download/${id}`
    });

  } catch (err: any) {
    if (job) {
      job.failed = true;
      job.done = true;
      log(job, `[SERVER ERROR] ${err.message}`);
    }

    return res.status(500).send(err.message);
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

  if (!id) {
    ws.send("Missing job id\n");
    return ws.close();
  }

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

  ws.on("close", () => {
    clearInterval(interval);
  });
});
