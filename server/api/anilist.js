const ANILIST_URL = 'https://graphql.anilist.co';

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english }
  coverImage { large extraLarge }
  bannerImage
  averageScore
  startDate { year }
  status
  episodes
  format
  genres
  tags { name rank isGeneralSpoiler isAdult }
  nextAiringEpisode { episode timeUntilAiring }
  description(asHtml: false)
  countryOfOrigin
  studios(isMain: true) { nodes { name } }
`;

async function gqlQuery(query, variables = {}) {
    const res = await fetch(ANILIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables })
    });

    const json = await res.json();

    if (!res.ok || json.errors) {
        const msg = json.errors?.[0]?.message || `HTTP ${res.status}`;
        throw new Error(`AniList: ${msg}`);
    }

    return json.data;
}

function getCurrentSeason() {
    const month = new Date().getMonth() + 1;
    const year  = new Date().getFullYear();
    let season;
    if (month <= 3)       season = 'WINTER';
    else if (month <= 6)  season = 'SPRING';
    else if (month <= 9)  season = 'SUMMER';
    else                  season = 'FALL';
    return { season, year };
}

function transform(item) {
    const type = item.format === 'MOVIE' ? 'movie' : 'tv';
    const tags = (item.tags || [])
        .filter(t => !t.isAdult && !t.isGeneralSpoiler && (t.rank || 0) >= 60)
        .slice(0, 4)
        .map(t => t.name);

    return {
        id:            null,
        anilistId:     item.id,
        malId:         item.idMal || null,
        type,
        isAnime:       true,
        title:         item.title.english || item.title.romaji,
        titleRomaji:   item.title.romaji,
        poster:        item.coverImage?.extraLarge || item.coverImage?.large,
        banner:        item.bannerImage,
        rating:        item.averageScore ? +(item.averageScore / 10).toFixed(1) : null,
        year:          item.startDate?.year,
        status:        item.status,
        episodes:      item.episodes,
        genres:        item.genres || [],
        tags,
        studio:        item.studios?.nodes?.[0]?.name || null,
        nextEpisode:   item.nextAiringEpisode || null,
        countryOfOrigin: item.countryOfOrigin,
    };
}

// Currently airing — sort must be an array for AniList
async function getAiring(page = 1) {
    const data = await gqlQuery(`
        query($page: Int) {
            Page(page: $page, perPage: 20) {
                media(status: RELEASING, type: ANIME, sort: [TRENDING_DESC],
                      isAdult: false, countryOfOrigin: "JP") { ${MEDIA_FIELDS} }
            }
        }
    `, { page });
    return data.Page.media.map(transform);
}

// Seasonal anime
async function getSeason(season, year, page = 1) {
    const data = await gqlQuery(`
        query($season: MediaSeason, $year: Int, $page: Int) {
            Page(page: $page, perPage: 20) {
                media(season: $season, seasonYear: $year, type: ANIME,
                      sort: [POPULARITY_DESC], isAdult: false, countryOfOrigin: "JP") { ${MEDIA_FIELDS} }
            }
        }
    `, { season, year, page });
    return data.Page.media.map(transform);
}

// By genre string e.g. "Action", "Romance"
async function getByGenre(genre, page = 1) {
    const data = await gqlQuery(`
        query($genre: String, $page: Int) {
            Page(page: $page, perPage: 20) {
                media(genre: $genre, type: ANIME, sort: [POPULARITY_DESC],
                      isAdult: false, countryOfOrigin: "JP") { ${MEDIA_FIELDS} }
            }
        }
    `, { genre, page });
    return data.Page.media.map(transform);
}

// By tag e.g. "Isekai", "Shounen", "Psychological"
async function getByTag(tag, page = 1) {
    const data = await gqlQuery(`
        query($tag: String, $page: Int) {
            Page(page: $page, perPage: 20) {
                media(tag: $tag, type: ANIME, sort: [POPULARITY_DESC],
                      isAdult: false, countryOfOrigin: "JP") { ${MEDIA_FIELDS} }
            }
        }
    `, { tag, page });
    return data.Page.media.map(transform);
}

// Top rated all time
async function getTop(page = 1) {
    const data = await gqlQuery(`
        query($page: Int) {
            Page(page: $page, perPage: 20) {
                media(type: ANIME, sort: [SCORE_DESC], isAdult: false,
                      countryOfOrigin: "JP", status_not: NOT_YET_RELEASED) { ${MEDIA_FIELDS} }
            }
        }
    `, { page });
    return data.Page.media.map(transform);
}

module.exports = { getAiring, getSeason, getByGenre, getByTag, getTop, getCurrentSeason };
