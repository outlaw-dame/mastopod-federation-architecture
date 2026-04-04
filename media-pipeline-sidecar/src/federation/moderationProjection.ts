export function buildActivityPubModeration(params: {
  sensitive?: boolean;
  contentWarning?: string;
}) {
  return {
    sensitive: params.sensitive,
    summary: params.contentWarning
  };
}

export function buildATProtoModeration(params: {
  labels: string[];
}) {
  return {
    labels: params.labels.map((l) => ({ val: l }))
  };
}
