import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Transcrever PT-BR — Transcrição de áudio no navegador" },
      {
        name: "description",
        content:
          "Transcreva arquivos .wav e .mp3 em português brasileiro direto no navegador. 100% local, sem upload, sem servidor.",
      },
      { property: "og:title", content: "Transcrever PT-BR" },
      {
        property: "og:description",
        content: "Transcrição de áudio em PT-BR 100% no navegador, sem enviar seus arquivos para nenhum servidor.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Stage = "idle" | "loading-model" | "decoding" | "transcribing" | "done" | "error";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}h ${m}min ${sec}s`
    : m > 0
      ? `${m}min ${sec}s`
      : `${sec}s`;
}

async function decodeToMono16k(file: File): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer();
  const AC: typeof AudioContext =
    (window.AudioContext as typeof AudioContext) ||
    ((window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  const tempCtx = new AC();
  const decoded = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
  await tempCtx.close();

  const targetRate = 16000;
  const targetLength = Math.ceil(decoded.duration * targetRate);
  const offline = new OfflineAudioContext(1, targetLength, targetRate);
  const src = offline.createBufferSource();

  // Downmix to mono manually into a new buffer at original rate, then let offline resample.
  const monoBuf = offline.createBuffer(1, decoded.length, decoded.sampleRate);
  const monoData = monoBuf.getChannelData(0);
  const chCount = decoded.numberOfChannels;
  for (let ch = 0; ch < chCount; ch++) {
    const chData = decoded.getChannelData(ch);
    for (let i = 0; i < chData.length; i++) monoData[i] += chData[i] / chCount;
  }
  src.buffer = monoBuf;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function Index() {
  const [file, setFile] = useState<File | null>(null);
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [modelProgress, setModelProgress] = useState<number>(0);
  const [chunkDone, setChunkDone] = useState<number>(0);
  const [chunkTotal, setChunkTotal] = useState<number>(0);
  const [partialText, setPartialText] = useState<string>("");
  const [transcript, setTranscript] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [device, setDevice] = useState<string>("");
  const [dragActive, setDragActive] = useState(false);

  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const w = new Worker(new URL("../lib/transcribe.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = w;
    w.addEventListener("message", (ev: MessageEvent) => {
      const msg = ev.data;
      switch (msg.type) {
        case "status":
          setStatusMsg(msg.message);
          break;
        case "model-progress":
          setModelProgress(msg.progress ?? 0);
          setStatusMsg(`Baixando modelo: ${msg.file} (${Math.round(msg.progress ?? 0)}%)`);
          break;
        case "ready":
          setDevice(msg.device);
          setStatusMsg(`Modelo pronto. Acelerado via ${String(msg.device).toUpperCase()}.`);
          break;
        case "chunk-progress":
          setChunkDone(msg.done);
          setChunkTotal(msg.total);
          setPartialText(msg.partial);
          break;
        case "done":
          setTranscript(msg.text);
          setStage("done");
          setStatusMsg("Transcrição concluída.");
          break;
        case "error":
          setError(msg.message);
          setStage("error");
          break;
      }
    });
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  const handleFile = useCallback(async (f: File | null) => {
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!name.endsWith(".wav") && !name.endsWith(".mp3")) {
      setError("Formato não suportado. Envie um arquivo .wav ou .mp3.");
      return;
    }
    setError("");
    setTranscript("");
    setPartialText("");
    setChunkDone(0);
    setChunkTotal(0);
    setFile(f);
    setDurationSec(null);
    // Read duration quickly via HTMLAudioElement
    try {
      const url = URL.createObjectURL(f);
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.src = url;
      await new Promise<void>((resolve, reject) => {
        audio.onloadedmetadata = () => resolve();
        audio.onerror = () => reject(new Error("metadata"));
      });
      setDurationSec(audio.duration);
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  const startTranscription = async () => {
    if (!file || !workerRef.current) return;
    setStage("decoding");
    setStatusMsg("Decodificando áudio para 16kHz mono...");
    setError("");
    try {
      const audio = await decodeToMono16k(file);
      setStage("transcribing");
      setStatusMsg("Iniciando transcrição...");
      workerRef.current.postMessage(
        { type: "transcribe", audio, sampleRate: 16000 },
        [audio.buffer],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  };

  const downloadTxt = () => {
    if (!file || !transcript) return;
    const blob = new Blob([transcript], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file.name}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const progressPct = useMemo(() => {
    if (stage === "transcribing" && chunkTotal > 0) {
      return Math.min(99, Math.round((chunkDone / chunkTotal) * 100));
    }
    if (stage === "done") return 100;
    return 0;
  }, [stage, chunkDone, chunkTotal]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <header className="mb-10">
          <h1 className="text-3xl font-semibold tracking-tight">Transcrever PT-BR</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Transcrição de áudio em português, 100% no seu navegador. Nenhum arquivo é enviado para servidores.
          </p>
        </header>

        {!file && (
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-12 text-center transition-colors ${
              dragActive
                ? "border-primary bg-accent"
                : "border-border bg-card hover:border-primary/50"
            }`}
          >
            <div className="text-lg font-medium">Arraste um arquivo .wav ou .mp3</div>
            <div className="mt-1 text-sm text-muted-foreground">ou clique para selecionar</div>
            <input
              type="file"
              accept=".wav,.mp3,audio/wav,audio/mpeg"
              className="hidden"
              onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
            />
          </label>
        )}

        {file && (
          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate font-medium">{file.name}</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {formatBytes(file.size)}
                  {durationSec != null && ` • ${formatDuration(durationSec)}`}
                </div>
              </div>
              {stage === "idle" && (
                <button
                  onClick={() => {
                    setFile(null);
                    setDurationSec(null);
                  }}
                  className="text-sm text-muted-foreground underline-offset-4 hover:underline"
                >
                  Trocar
                </button>
              )}
            </div>

            {stage === "idle" && (
              <button
                onClick={startTranscription}
                className="mt-6 w-full rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Transcrever
              </button>
            )}

            {(stage === "decoding" || stage === "transcribing" || stage === "loading-model") && (
              <div className="mt-6 space-y-3">
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${
                        stage === "transcribing"
                          ? progressPct
                          : stage === "decoding"
                            ? 8
                            : modelProgress
                      }%`,
                    }}
                  />
                </div>
                <div className="text-sm text-muted-foreground">{statusMsg || "Processando..."}</div>
                {stage === "transcribing" && chunkTotal > 0 && (
                  <div className="text-xs text-muted-foreground">
                    Chunk {chunkDone} de ~{chunkTotal} • {device && `via ${device.toUpperCase()}`}
                  </div>
                )}
                {partialText && (
                  <div className="max-h-40 overflow-y-auto rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                    {partialText}
                  </div>
                )}
              </div>
            )}

            {stage === "done" && (
              <div className="mt-6 space-y-4">
                <div className="max-h-64 overflow-y-auto rounded-lg bg-muted/50 p-4 text-sm leading-relaxed">
                  {transcript}
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={downloadTxt}
                    className="flex-1 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    Baixar .txt
                  </button>
                  <button
                    onClick={() => {
                      setFile(null);
                      setTranscript("");
                      setPartialText("");
                      setChunkDone(0);
                      setChunkTotal(0);
                      setDurationSec(null);
                      setStage("idle");
                    }}
                    className="rounded-lg border border-border px-4 py-3 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    Novo arquivo
                  </button>
                </div>
              </div>
            )}

            {stage === "error" && (
              <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {error || "Ocorreu um erro."}
              </div>
            )}
          </div>
        )}

        {error && !file && (
          <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <footer className="mt-10 text-center text-xs text-muted-foreground">
          Processamento local via WebGPU/WASM. O modelo é baixado apenas na primeira execução e fica em cache.
        </footer>
      </div>
    </div>
  );
}
