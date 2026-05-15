/**
 * LLM subsystem types, shared across processes.
 *
 * PSF Helm runs its own private Ollama instance. It does not touch the
 * system Ollama daemon. The isolation contract is non-negotiable.
 */

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  /** Helm's private port. Distinct from system Ollama's 11434. */
  port: number;
  pid: number | null;
  binaryPath: string;
  modelsPath: string;
  /** Snapshot of the isolation env vars used to spawn this Ollama. */
  env: {
    OLLAMA_HOST: string;
    OLLAMA_MODELS: string;
    OLLAMA_ORIGINS: string;
    CUDA_VISIBLE_DEVICES?: string;
  };
  /** Bytes used by the binary + libraries under ~/.local/share/psf-helm/ollama/. */
  bytesUsed: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    [key: string]: unknown;
  };
}

export interface ChatStreamChunk {
  model: string;
  created_at: string;
  message: {
    role: "assistant";
    content: string;
  };
  done: boolean;
}
