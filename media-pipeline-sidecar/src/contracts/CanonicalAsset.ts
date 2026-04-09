export interface CanonicalAsset {
  assetId:string
  ownerId:string
  mimeType:string
  size:number
  variants:{
    original?:string
    streaming?:{
      hlsMaster?:string
      dashManifest?:string
    }
  }
  createdAt:string
}
