export type RapidApiRateLimits = {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
};

export type SpariorCallResult<T> = {
  data: T;
  rateLimits: RapidApiRateLimits;
  durationMs: number;
  retries: number;
};

export type SpariorRawProfile = {
  id?: string | number | null;
  pk?: string | number | null;
  username?: string | null;
  full_name?: string | null;
  fullName?: string | null;
  biography?: string | null;
  bio?: string | null;
  profile_pic_url?: string | null;
  profilePicUrl?: string | null;
  profile_pic_url_hd?: string | null;
  follower_count?: number | string | null;
  followers?: number | string | null;
  followers_count?: number | string | null;
  following_count?: number | string | null;
  following?: number | string | null;
  media_count?: number | string | null;
  posts_count?: number | string | null;
  is_verified?: boolean | null;
  verified?: boolean | null;
  is_business?: boolean | null;
  is_business_account?: boolean | null;
  is_private?: boolean | null;
  category?: string | null;
  category_name?: string | null;
  business_category_name?: string | null;
  external_url?: string | null;
  website?: string | null;
  public_email?: string | null;
  email?: string | null;
  public_phone_number?: string | null;
  phone?: string | null;
  city_name?: string | null;
  location?: string | null;
  [key: string]: unknown;
};

export type SpariorRawSearchItem = {
  username?: string | null;
  user?: SpariorRawProfile | null;
  pk?: string | number | null;
  id?: string | number | null;
  full_name?: string | null;
  is_private?: boolean | null;
  is_verified?: boolean | null;
  profile_pic_url?: string | null;
  profile_pic?: string | null;
  social_context?: string | null;
  profile_url?: string | null;
  [key: string]: unknown;
};

export type SpariorSearchResponse = {
  body?: SpariorRawSearchItem[] | null;
  meta?: {
    version?: string;
    status?: number;
    search?: string;
    total?: number;
    [key: string]: unknown;
  } | null;
  data?:
    | {
        items?: SpariorRawSearchItem[] | null;
        users?: SpariorRawSearchItem[] | null;
        results?: SpariorRawSearchItem[] | null;
        next_cursor?: string | null;
        cursor?: string | null;
        has_more?: boolean | null;
        more_available?: boolean | null;
      }
    | SpariorRawSearchItem[]
    | null;
  cursor?: string | null;
  next_cursor?: string | null;
  has_more?: boolean | null;
  [key: string]: unknown;
};

export type SpariorProfileResponse = {
  data?: SpariorRawProfile | null;
  [key: string]: unknown;
};
