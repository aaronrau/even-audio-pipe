import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

type OrtApi = typeof import('onnxruntime-node')
type OrtTensor = InstanceType<OrtApi['Tensor']>
type OrtSession = Awaited<ReturnType<OrtApi['InferenceSession']['create']>>

export interface SileroFrameVadOptions {
  modelPath?: string
  positiveSpeechThreshold?: number
  negativeSpeechThreshold?: number
}

export interface SileroFrameDecision {
  speech: boolean
  backend: 'silero'
  probability: number
}

export class SileroFrameVad {
  private ort: OrtApi
  private session: OrtSession
  private h: OrtTensor
  private c: OrtTensor
  private sr: OrtTensor
  private speaking = false
  private positiveSpeechThreshold: number
  private negativeSpeechThreshold: number

  private constructor(ort: OrtApi, session: OrtSession, options: Required<Pick<SileroFrameVadOptions, 'positiveSpeechThreshold' | 'negativeSpeechThreshold'>>) {
    this.ort = ort
    this.session = session
    this.positiveSpeechThreshold = options.positiveSpeechThreshold
    this.negativeSpeechThreshold = options.negativeSpeechThreshold
    this.sr = new this.ort.Tensor('int64', [16000n])
    this.h = this.hiddenStateTensor()
    this.c = this.hiddenStateTensor()
  }

  static async create(options: SileroFrameVadOptions = {}) {
    const ort = await import('onnxruntime-node')
    const modelPath = options.modelPath || require.resolve('@ricky0123/vad-node/dist/silero_vad.onnx')
    const model = await readFile(modelPath)
    const session = await ort.InferenceSession.create(model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength))

    return new SileroFrameVad(ort, session, {
      positiveSpeechThreshold: finiteNumber(options.positiveSpeechThreshold, 0.5),
      negativeSpeechThreshold: finiteNumber(options.negativeSpeechThreshold, finiteNumber(options.positiveSpeechThreshold, 0.5) - 0.15),
    })
  }

  reset() {
    this.speaking = false
    this.h = this.hiddenStateTensor()
    this.c = this.hiddenStateTensor()
  }

  async analyzeFrame(frame: Buffer): Promise<SileroFrameDecision> {
    const audio = pcm16ToFloat32(frame)
    const input = new this.ort.Tensor('float32', audio, [1, audio.length])
    const output = await this.session.run({
      input,
      h: this.h,
      c: this.c,
      sr: this.sr,
    })

    this.h = output.hn as OrtTensor
    this.c = output.cn as OrtTensor
    const probability = Number(output.output?.data?.[0] || 0)

    if (probability >= this.positiveSpeechThreshold) {
      this.speaking = true
    } else if (probability < this.negativeSpeechThreshold) {
      this.speaking = false
    }

    return {
      speech: this.speaking,
      backend: 'silero',
      probability,
    }
  }

  private hiddenStateTensor() {
    return new this.ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64])
  }
}

export async function createSileroFrameVad(options: SileroFrameVadOptions = {}) {
  return SileroFrameVad.create(options)
}

export function pcm16ToFloat32(frame: Buffer) {
  const samples = Math.floor(frame.byteLength / 2)
  const audio = new Float32Array(samples)

  for (let index = 0; index < samples; index += 1) {
    audio[index] = frame.readInt16LE(index * 2) / 32768
  }

  return audio
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
