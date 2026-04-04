export interface RankingInput {
  query?: string;
  labels?: string[];
  boostRecent?: boolean;
  safeMode?: boolean;
}

export function buildOpenSearchQuery(params: RankingInput) {
  const must: any[] = [];
  const should: any[] = [];
  const mustNot: any[] = [];

  if (params.query) {
    must.push({
      multi_match: {
        query: params.query,
        fields: ['content^3', 'tags^2', 'altText'],
        fuzziness: 'AUTO'
      }
    });
  }

  if (params.safeMode) {
    mustNot.push({ term: { labels: 'nsfw' } });
    mustNot.push({ term: { labels: 'graphic-media' } });
  }

  if (params.boostRecent) {
    should.push({
      function_score: {
        functions: [
          {
            gauss: {
              createdAt: {
                origin: 'now',
                scale: '7d',
                decay: 0.5
              }
            }
          }
        ]
      }
    });
  }

  return {
    query: {
      bool: {
        must,
        should,
        must_not: mustNot
      }
    }
  };
}
