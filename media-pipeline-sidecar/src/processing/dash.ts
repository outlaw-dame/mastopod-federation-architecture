import path from 'node:path'
import { runFfmpeg } from './ffmpeg.js'

export async function generateDASH(inputPath:string,dir:string){
  const out = path.join(dir,'manifest.mpd')

  await runFfmpeg([
    '-y','-i',inputPath,
    '-map','0:v','-map','0:a',
    '-c:v','libx264','-c:a','aac',
    '-f','dash','-use_timeline','1','-use_template','1',
    out
  ])

  return out
}
