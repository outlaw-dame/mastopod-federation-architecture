export function buildCdnUrl(basePath:string){
  const cdn = process.env.CDN_BASE_URL || ''
  if(!cdn) return basePath
  return `${cdn.replace(/\/$/, '')}/${basePath.replace(/^\//,'')}`
}
