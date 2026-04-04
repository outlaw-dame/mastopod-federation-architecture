export function buildCloudflareCdnUrl(baseDomain: string, path: string): string {
  return `https://${baseDomain}/${path.replace(/^\//, '')}`;
}

export function buildImageDeliveryUrl(params: {
  accountHash: string;
  imageId: string;
  variant: string;
  domain?: string;
}) {
  if (params.domain) {
    return `https://${params.domain}/cdn-cgi/imagedelivery/${params.accountHash}/${params.imageId}/${params.variant}`;
  }

  return `https://imagedelivery.net/${params.accountHash}/${params.imageId}/${params.variant}`;
}
