import { toImageView } from '../media/media.urls.js';
import type { MovieDetailRow, MovieSummaryRow } from './movies.repository.js';
import type { MovieSummary } from './movies.schemas.js';

const round1 = (n: number) => Math.round(n * 10) / 10;

export function toMovieSummary(m: MovieSummaryRow): MovieSummary {
  return {
    id: m.id,
    slug: m.slug,
    title: m.title,
    originalTitle: m.originalTitle,
    releaseYear: m.releaseYear,
    durationMinutes: m.durationMinutes,
    ageRating: m.ageRating,
    accessTier: m.accessTier,
    language: m.language,
    country: m.country,
    featured: m.featured,
    poster: toImageView(m.poster),
    backdrop: toImageView(m.backdrop),
    genres: m.genres.map((g) => g.genre),
    rating: { average: round1(m.ratingAvg), count: m.ratingCount },
  };
}

export function toMovieDetail(m: MovieDetailRow) {
  return {
    ...toMovieSummary(m),
    overview: m.overview,
    releaseDate: m.releaseDate ? m.releaseDate.toISOString().slice(0, 10) : null,
    originalLanguage: m.originalLanguage,
    trailerUrl: m.trailerUrl,
    seoTitle: m.seoTitle,
    seoDescription: m.seoDescription,
    subtitleLanguages: m.subtitleLanguages,
    publishedAt: m.publishedAt?.toISOString() ?? null,
    cast: m.cast.map((c) => ({ ...c.person, photo: toImageView(c.person.photo), characterName: c.characterName, order: c.order })),
    crew: m.crew.map((c) => ({ ...c.person, photo: toImageView(c.person.photo), job: c.job, jobTitle: c.jobTitle })),
    availableQualities: [...new Set(m.videos.map((v) => v.qualityLabel).filter((q): q is string => Boolean(q)))],
  };
}

export function toAdminMovie(m: MovieDetailRow) {
  return {
    ...toMovieDetail(m),
    status: m.status,
    visibility: m.visibility,
    externalIds: (m.externalIds as Record<string, string> | null) ?? null,
    viewCount: m.viewCount,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    deletedAt: m.deletedAt?.toISOString() ?? null,
  };
}
