/// <reference lib="webworker" />
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

// Allow remote model downloads; disable local model lookup on the static site.
env.allowLocalModels = false;
env.allowRemoteModels = true;

type InMsg =
  | { type: "init" }
  | { type: "transcribe"; audio: Float32Array; sampleRate: number };

type OutMsg =
  | { type: "status"; message: string }
  | { type: "model-progress"; file: string; progress: number; loaded?: number; total?: number }
  | { type: "chunk-progress"; done: number; total: number; partial: string }
  | { type: "ready"; device: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let device: "webgpu" | "wasm" = "wasm";

function post(msg: OutMsg) {
  (self as unknown as Worker).postMessage(msg);
}

async function detectWebGPU(): Promise<boolean> {
  try {
    const nav = navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } };
    if (!nav.gpu) return false;
    const adapter = await nav.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

async function getPipeline() {
  if (asr) return asr;
  const hasWebGPU = await detectWebGPU();
  device = hasWebGPU ? "webgpu" : "wasm";
  post({ type: "status", message: `Carregando modelo (${device.toUpperCase()})... isso ocorre apenas na primeira vez.` });

  const modelId = "onnx-community/whisper-base";
  asr = (await pipeline("automatic-speech-recognition", modelId, {
    device,
    dtype: hasWebGPU ? "fp32" : "q8",
    progress_callback: (data: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
      if (data.status === "progress" && data.file) {
        post({
          type: "model-progress",
          file: data.file,
          progress: data.progress ?? 0,
          loaded: data.loaded,
          total: data.total,
        });
      } else if (data.status === "download" && data.file) {
        post({ type: "status", message: `Baixando ${data.file}...` });
      }
    },
  })) as AutomaticSpeechRecognitionPipeline;
  post({ type: "ready", device });
  return asr;
}

self.addEventListener("message", async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      await getPipeline();
      return;
    }
    if (msg.type === "transcribe") {
      const pipe = await getPipeline();
      post({ type: "status", message: "Preparando transcrição..." });

      // Estimate chunk count for progress
      const chunkSeconds = 30;
      const strideSeconds = 5;
      const totalSeconds = msg.audio.length / msg.sampleRate;
      const estTotal = Math.max(1, Math.ceil(totalSeconds / (chunkSeconds - strideSeconds)));
      let done = 0;
      let partial = "";

      const result = (await pipe(msg.audio, {
        chunk_length_s: chunkSeconds,
        stride_length_s: strideSeconds,
        language: "portuguese",
        task: "transcribe",
        return_timestamps: false,
        // Fires after each chunk finishes decoding.
        chunk_callback: (chunk: { text?: string }) => {
          done += 1;
          if (chunk?.text) partial += (partial ? " " : "") + chunk.text.trim();
          post({ type: "chunk-progress", done, total: estTotal, partial });
        },
      } as unknown as Parameters<typeof pipe>[1])) as { text: string } | { text: string }[];

      const text = Array.isArray(result) ? result.map((r) => r.text).join(" ") : result.text;
      post({ type: "done", text: text.trim() });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: "error", message });
  }
});

export {};