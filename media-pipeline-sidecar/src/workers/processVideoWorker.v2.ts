import { generateHLS } from '../processing/hls.js'
import { generateDASH } from '../processing/dash.js'
import { probeVideo } from '../processing/ffprobe.js'
import { uploadWithLimit } from '../utils/uploadPool.js'
import { buildCdnUrl } from '../utils/cdnUrl.js'
import { promises as fs } from 'node:fs'

export async function processVideoWorker(message, { uploadToFilebase, saveAsset, fileHash }) {
  const input = Buffer.from(message.bytesBase64, 'base64')
  const tmpPath = `/tmp/${message.traceId}.mp4`

  await fs.writeFile(tmpPath, input)

  const meta = await probeVideo(tmpPath)
  if (meta.duration > 600) throw new Error('Video too long')

  const hls = await generateHLS(tmpPath)
  const dash = await generateDASH(tmpPath, hls.dir)

  const base = `video/${fileHash}`

  await uploadToFilebase({ key: `${base}/master.m3u8`, body: hls.master, contentType: 'application/vnd.apple.mpegurl' })

  await uploadWithLimit(hls.variants, 4, async (v) => {
    await uploadToFilebase({ key: `${base}/${v.name}.m3u8`, body: v.playlist, contentType: 'application/vnd.apple.mpegurl' })

    await uploadWithLimit(v.segments, 4, async (seg) => {
      await uploadToFilebase({ key: `${base}/${seg.name}`, body: seg.buffer, contentType: 'video/mp4' })
    })
  })

  await uploadToFilebase({ key: `${base}/manifest.mpd`, body: await fs.readFile(dash), contentType: 'application/dash+xml' })

  const asset = {
    assetId: fileHash,
    ownerId: message.ownerId,
    mimeType: 'video/mp4',
    size: input.length,
    variants: {
      streaming: {
        hlsMaster: buildCdnUrl(`${base}/master.m3u8`),
        dashManifest: buildCdnUrl(`${base}/manifest.mpd`)
      }
    },
    createdAt: new Date().toISOString()
  }

  await saveAsset(asset)

  return asset
}
