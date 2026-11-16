import type { TmdbDetail, TmdbMovie } from "../adapters/types.js";

// A small, real-looking movie catalog for demo mode and tests. Facts only
// (titles, years, genres, IDs); posters are generated SVGs.

export const GENRES: { id: number; name: string }[] = [
  { id: 28, name: "Action" }, { id: 12, name: "Adventure" }, { id: 16, name: "Animation" }, { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" }, { id: 18, name: "Drama" }, { id: 10751, name: "Family" }, { id: 14, name: "Fantasy" },
  { id: 27, name: "Horror" }, { id: 9648, name: "Mystery" }, { id: 10749, name: "Romance" }, { id: 878, name: "Science Fiction" },
  { id: 53, name: "Thriller" }, { id: 10402, name: "Music" },
];

// [tmdbId, title, year, genreIds, rating, runtime, imdbId, director, tagline]
type Row = [number, string, number, number[], number, number, string, string, string];
const ROWS: Row[] = [
  [949, "Heat", 1995, [28, 80, 18], 7.9, 170, "tt0113277", "Michael Mann", "A Los Angeles crime saga."],
  [603, "The Matrix", 1999, [28, 878], 8.2, 136, "tt0133093", "Lana Wachowski", "Welcome to the real world."],
  [27205, "Inception", 2010, [28, 878, 12], 8.4, 148, "tt1375666", "Christopher Nolan", "Your mind is the scene of the crime."],
  [157336, "Interstellar", 2014, [12, 18, 878], 8.4, 169, "tt0816692", "Christopher Nolan", "Mankind was born on Earth. It was never meant to die here."],
  [438631, "Dune", 2021, [878, 12], 7.8, 155, "tt1160419", "Denis Villeneuve", "It begins."],
  [693134, "Dune: Part Two", 2024, [878, 12], 8.2, 167, "tt15239678", "Denis Villeneuve", "Long live the fighters."],
  [335984, "Blade Runner 2049", 2017, [878, 18], 7.6, 164, "tt1856101", "Denis Villeneuve", "The key to the future is finally unearthed."],
  [76341, "Mad Max: Fury Road", 2015, [28, 12, 878], 7.6, 121, "tt1392190", "George Miller", "What a lovely day."],
  [496243, "Parasite", 2019, [35, 53, 18], 8.5, 133, "tt6751668", "Bong Joon Ho", "Act like you own the place."],
  [129, "Spirited Away", 2001, [16, 10751, 14], 8.5, 125, "tt0245429", "Hayao Miyazaki", "Nothing that happens is ever forgotten."],
  [155, "The Dark Knight", 2008, [18, 28, 80, 53], 8.5, 152, "tt0468569", "Christopher Nolan", "Welcome to a world without rules."],
  [680, "Pulp Fiction", 1994, [53, 80], 8.5, 154, "tt0110912", "Quentin Tarantino", "Just because you are a character doesn't mean you have character."],
  [238, "The Godfather", 1972, [18, 80], 8.7, 175, "tt0068646", "Francis Ford Coppola", "An offer you can't refuse."],
  [329865, "Arrival", 2016, [18, 878, 9648], 7.6, 116, "tt2543164", "Denis Villeneuve", "Why are they here?"],
  [872585, "Oppenheimer", 2023, [18, 36], 8.1, 181, "tt15398776", "Christopher Nolan", "The world forever changes."],
  [545611, "Everything Everywhere All at Once", 2022, [28, 12, 878], 7.8, 140, "tt6710474", "Daniel Kwan", "The universe is so much bigger than you realize."],
  [244786, "Whiplash", 2014, [18, 10402], 8.4, 107, "tt2582802", "Damien Chazelle", "The road to greatness can take you to the edge."],
  [313369, "La La Land", 2016, [35, 18, 10749, 10402], 7.9, 128, "tt3783958", "Damien Chazelle", "Here's to the fools who dream."],
  [419430, "Get Out", 2017, [9648, 53, 27], 7.6, 104, "tt5052448", "Jordan Peele", "Just because you're invited, doesn't mean you're welcome."],
  [546554, "Knives Out", 2019, [35, 80, 9648], 7.8, 131, "tt8946378", "Rian Johnson", "Hell, any of them could have done it."],
  [120467, "The Grand Budapest Hotel", 2014, [35, 18], 8.0, 100, "tt2278388", "Wes Anderson", "A murder case of Madam D."],
  [152601, "Her", 2013, [10749, 878, 18], 7.8, 126, "tt1798709", "Spike Jonze", "A Spike Jonze love story."],
  [361743, "Top Gun: Maverick", 2022, [28, 18], 8.2, 131, "tt1745960", "Joseph Kosinski", "Feel the need... The need for speed."],
  [324857, "Spider-Man: Into the Spider-Verse", 2018, [28, 12, 16, 878], 8.4, 117, "tt4633694", "Peter Ramsey", "More than one wears the mask."],
  [862, "Toy Story", 1995, [16, 12, 10751, 35], 8.0, 81, "tt0114709", "John Lasseter", "The adventure takes off!"],
  [10681, "WALL·E", 2008, [16, 10751, 878], 8.1, 98, "tt0910970", "Andrew Stanton", "After 700 years of doing what he was built for, he'll discover what he was meant for."],
  [278, "The Shawshank Redemption", 1994, [18, 80], 8.7, 142, "tt0111161", "Frank Darabont", "Fear can hold you prisoner. Hope can set you free."],
  [348, "Alien", 1979, [27, 878], 8.2, 117, "tt0078748", "Ridley Scott", "In space no one can hear you scream."],
  [578, "Jaws", 1975, [27, 53, 12], 7.7, 124, "tt0073195", "Steven Spielberg", "You'll never go in the water again."],
  [105, "Back to the Future", 1985, [12, 35, 878], 8.3, 116, "tt0088763", "Robert Zemeckis", "He's the only kid ever to get into trouble before he was born."],
  [329, "Jurassic Park", 1993, [12, 878], 7.9, 127, "tt0107290", "Steven Spielberg", "An adventure 65 million years in the making."],
  [37799, "The Social Network", 2010, [18], 7.4, 120, "tt1285016", "David Fincher", "You don't get to 500 million friends without making a few enemies."],
  [6977, "No Country for Old Men", 2007, [80, 18, 53], 7.9, 122, "tt0477348", "Joel Coen", "There are no clean getaways."],
  [273481, "Sicario", 2015, [28, 80, 53], 7.4, 122, "tt3397884", "Denis Villeneuve", "In the land of wolves, you will become a wolf."],
  [146233, "Prisoners", 2013, [18, 53, 80], 8.1, 153, "tt1392214", "Denis Villeneuve", "Every moment matters."],
  [64690, "Drive", 2011, [18, 53, 80], 7.6, 100, "tt0780504", "Nicolas Winding Refn", "There are no clean getaways."],
  [9999001, "The Unfindable Reel", 1931, [18], 6.1, 88, "tt9999001", "Nobody Known", "No release exists for this one."],
];

export const FAKE_NO_RELEASES_ID = 9999001;

const year = (r: Row) => `${r[2]}-06-15`;

export function fakeMovies(): TmdbMovie[] {
  return ROWS.map((r, i) => ({
    id: r[0],
    title: r[1],
    original_title: r[1],
    release_date: year(r),
    overview: `${r[8]} A ${GENRES.find((g) => g.id === r[3][0])?.name.toLowerCase()} film from ${r[2]}, directed by ${r[7]}.`,
    poster_path: `/fake/${r[0]}.svg`,
    backdrop_path: `/fake/${r[0]}-bd.svg`,
    vote_average: r[4],
    vote_count: 1000 + i * 37,
    genre_ids: r[3],
    popularity: 100 - i,
  }));
}

export function fakeDetail(id: number): TmdbDetail | null {
  const r = ROWS.find((x) => x[0] === id);
  const m = fakeMovies().find((x) => x.id === id);
  if (!r || !m) return null;
  const recs = fakeMovies().filter((x) => x.id !== id && x.genre_ids?.some((g) => r[3].includes(g))).slice(0, 12);
  return {
    ...m,
    runtime: r[5],
    genres: r[3].map((g) => GENRES.find((x) => x.id === g)!).filter(Boolean),
    tagline: r[8],
    imdb_id: r[6],
    credits: { cast: [{ name: "Lead Actor", character: "Protagonist" }, { name: "Second Lead", character: "Antagonist" }], crew: [{ name: r[7], job: "Director" }] },
    recommendations: { results: recs },
    release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "R", type: 3 }] }] },
  };
}

/** Deterministic gradient poster with the title, for demo mode. */
export function fakePosterSvg(id: number, backdrop: boolean): string {
  const m = fakeMovies().find((x) => x.id === id);
  const title = (m?.title ?? "Untitled").replace(/[<&>]/g, "");
  const h1 = (id * 47) % 360;
  const h2 = (h1 + 60) % 360;
  const [w, h] = backdrop ? [1280, 720] : [342, 513];
  const words = title.split(" ");
  const lines: string[] = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last && (last + " " + word).length <= (backdrop ? 24 : 12)) lines[lines.length - 1] = last + " " + word;
    else lines.push(word);
  }
  const fs = backdrop ? 72 : 40;
  const y0 = h / 2 - ((lines.length - 1) * fs * 1.15) / 2;
  const text = lines.map((l, i) => `<text x="50%" y="${y0 + i * fs * 1.15}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="800" font-size="${fs}" fill="#fff">${l}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1},65%,32%)"/><stop offset="1" stop-color="hsl(${h2},70%,12%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.8}" cy="${h * 0.2}" r="${w * 0.35}" fill="hsl(${h2},80%,60%)" opacity="0.12"/>${text}<text x="50%" y="${h - 28}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="${backdrop ? 28 : 18}" fill="#fff" opacity="0.7">${m?.release_date?.slice(0, 4) ?? ""}</text></svg>`;
}
