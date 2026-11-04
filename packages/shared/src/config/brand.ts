// Bundlers swap this import for S7VIDEO_CONFIG (scripts/lib/brand-config.ts); plain Node uses the default.
import config from "../../../../s7video.config.ts";
import { brandIdentity, decodeBrandConfig, githubRepositorySlug } from "./brandConfig.ts";

export const BRAND = decodeBrandConfig(config);

export const BRAND_GITHUB_REPOSITORY = githubRepositorySlug(BRAND.urls.repository);

export const brandIdentityFor = (isDevelopment: boolean) => brandIdentity(BRAND, isDevelopment);
