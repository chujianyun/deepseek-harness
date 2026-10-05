/**
 * Default local embedding model and runtime: Qwen3-Embedding-0.6B (q8 ONNX export) and the
 * onnxruntime-node build that runs it. Sizes and sha256 digests are those the mirrors publish;
 * deployments can restate them through the plugin configuration.
 */
import type { LocalModelSpec, RuntimeSpec } from './index.ts'

/** Qwen3-Embedding-0.6B, the q8 weights of the onnx-community export. */
export const QWEN3_EMBEDDING: LocalModelSpec = {
  id: 'local/qwen3-embedding-0.6b',
  name: 'Qwen3-Embedding-0.6B',
  repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
  weights: 'onnx/model_quantized.onnx',
  maxTokens: 2048,
  files: [
    { path: 'config.json', size: 1576, sha256: '66a10929782f3c9a3cd5dec90e2a95c60e05736134a63cd54479eeae80bed175' },
    { path: 'tokenizer_config.json', size: 9731, sha256: '977648852447cb6587327ff3205b0a84cf2fc9f05621d6c8e88a497caafab2e1' },
    { path: 'tokenizer.json', size: 11_423_705, sha256: 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a' },
    { path: 'onnx/model_quantized.onnx', size: 613_527_631, sha256: '87cd124e0ef1fd1f223ebc283efccbaeac386d0b08344701c46975d0657b591f' },
  ],
}

/** onnxruntime-node 1.25.1 and its JavaScript API package, as npm tarballs. */
export const ONNX_RUNTIME: RuntimeSpec = {
  version: '1.25.1',
  platforms: ['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'],
  packages: [
    { name: 'onnxruntime-common', size: 66_042, sha256: '93d489fd6c412bc5cb58fccce9b6ba343882c2ab82045880f31d545a3c79d708' },
    { name: 'onnxruntime-node', size: 88_440_024, sha256: '582c44aac00414a5580fe9dcbebcb12c8bf1cc703ab3507203455db842e168f9' },
  ],
}
