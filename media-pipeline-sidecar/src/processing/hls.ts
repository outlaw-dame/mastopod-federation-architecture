import { tmpdir } from 'node:os'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runFfmpegWithEncoderFallback } from './ffmpeg.js'
import { DEFAULT_VIDEO_PACKAGING_POLICY } from './videoPolicy.js'

export async function generateHLS(inputPath:string){
  const dir = path.join(tmpdir(),`hls-${randomUUID()}`)
  await fs.mkdir(dir,{recursive:true})

  const variants:any[] = []

  for(const r of DEFAULT_VIDEO_PACKAGING_POLICY.renditions){
    const playlist = `${r.name}.m3u8`

    await runFfmpegWithEncoderFallback({
      preferredEncoder: DEFAULT_VIDEO_PACKAGING_POLICY.encoderPreference,
      buildArgs:(enc)=>[
        '-y','-i',inputPath,
        '-vf',`scale=-2:${r.height}`,
        '-c:v',enc,'-b:v',`${r.bitrateKbps}k`,'-preset','veryfast',
        '-c:a','aac','-b:a',`${r.audioBitrateKbps}k`,
        '-f','hls','-hls_time','4','-hls_playlist_type','vod',
        '-hls_segment_type','fmp4',
        '-hls_fmp4_init_filename',`${r.name}_init.mp4`,
        '-hls_segment_filename',path.join(dir,`${r.name}_%03d.m4s`),
        path.join(dir,playlist)
      ]
    })

    const files = await fs.readdir(dir)
    const segments = await Promise.all(
      files.filter(f=>f.startsWith(r.name)&&f.endsWith('.m4s'))
      .map(async name=>({name,buffer:await fs.readFile(path.join(dir,name))}))
    )

    variants.push({
      name:r.name,
      playlist:await fs.readFile(path.join(dir,playlist)),
      segments
    })
  }

  const master = variants.map(v=>`#EXT-X-STREAM-INF:BANDWIDTH=2000000\n${v.name}.m3u8`).join('\n')

  await fs.writeFile(path.join(dir,'master.m3u8'),master)

  return {dir,master:await fs.readFile(path.join(dir,'master.m3u8')),variants}
}
