import { spawn } from 'node:child_process'
import { once } from 'node:events'

export async function probeVideo(file: string) {
  const proc = spawn(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v','error','-print_format','json','-show_streams','-show_format',file
  ])

  let output = ''
  proc.stdout.on('data', d => output += d.toString())

  const [code] = await once(proc, 'close') as [number]

  if (code !== 0) throw new Error('ffprobe failed')

  const json = JSON.parse(output)
  const video = json.streams?.find((s:any)=>s.codec_type==='video')

  return {
    duration: Number(json.format?.duration||0),
    width: video?.width,
    height: video?.height
  }
}