import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 本地识字：只对「图里有字」的图有用（截图、聊天记录、通知）
// 纯文本模型也能因此知道图里写了什么。

const MIN_TEXT = 6

export async function ocrImage(base64, mime = 'image/jpeg') {
  const ext = mime.includes('png') ? 'png' : 'jpg'
  const file = path.join(os.tmpdir(), `wx-ocr-${Date.now()}.${ext}`)
  try {
    fs.writeFileSync(file, Buffer.from(base64, 'base64'))
    // tesseract 最后一个参数是输出目标，漏了会只打印用法
    const text = await run(['-l', 'chi_sim+eng', '--psm', '6', file, 'stdout'])
    const clean = text
      .replace(/\s+/g, ' ')
      .trim()
    return clean.length >= MIN_TEXT ? clean.slice(0, 500) : ''
  } catch {
    return ''
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {
      /* 临时文件删不掉也无所谓 */
    }
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('tesseract', args, { timeout: 20_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout || ''))
    })
  })
}
