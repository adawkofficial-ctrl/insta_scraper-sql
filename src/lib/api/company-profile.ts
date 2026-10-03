import { apiFetch } from "./client";

export type CompanyServiceEntry = { name: string; value?: string };

export type CompanyProfile = {
  id: string;
  name: string;
  isDefault: boolean;
  description: string;
  services: CompanyServiceEntry[];
  targetIndustries: string[];
  targetCountries: string[];
  idealCustomerProfile: string | null;
  brandTone: string | null;
  messageLanguage: string;
  preferredLength: { minWords: number; maxWords: number } | null;
  ctaStyle: string | null;
  forbiddenClaims: string[];
  pricingPolicy: string | null;
  exampleMessages: string[];
  objectionNotes: string | null;
  createdAt: string;
  updatedAt: string;
  campaignCount?: number;
};

export type CompanyProfileCompleteness = {
  complete: boolean;
  missingFields: string[];
  warnings: string[];
};

export type CompanyProfileResponse = {
  profile: CompanyProfile | null;
  completeness: CompanyProfileCompleteness;
};

export type CompanyProfilesListItem = {
  profile: CompanyProfile;
  completeness: CompanyProfileCompleteness;
  campaignCount: number;
};

export type CompanyProfilesListResponse = {
  profiles: CompanyProfilesListItem[];
};

export type CompanyProfileInput = {
  name: string;
  isDefault?: boolean;
  description?: string;
  services?: Array<{ name: string; value?: string }>;
  targetIndustries?: string[];
  targetCountries?: string[];
  idealCustomerProfile?: string | null;
  brandTone?: string | null;
  messageLanguage?: string;
  preferredLength?: { minWords: number; maxWords: number } | null;
  ctaStyle?: string | null;
  forbiddenClaims?: string[];
  pricingPolicy?: string | null;
  exampleMessages?: string[];
  objectionNotes?: string | null;
};

export async function listCompanyProfiles(): Promise<CompanyProfilesListResponse> {
  return apiFetch<CompanyProfilesListResponse>("/api/company-profiles");
}

export async function getCompanyProfileById(profileId: string): Promise<CompanyProfileResponse> {
  return apiFetch<CompanyProfileResponse>(`/api/company-profiles/${profileId}`);
}

export async function createCompanyProfile(
  input: CompanyProfileInput,
): Promise<CompanyProfileResponse> {
  return apiFetch<CompanyProfileResponse>("/api/company-profiles", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateCompanyProfile(
  profileId: string,
  input: Partial<CompanyProfileInput>,
): Promise<CompanyProfileResponse> {
  return apiFetch<CompanyProfileResponse>(`/api/company-profiles/${profileId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteCompanyProfile(
  profileId: string,
): Promise<{ success: boolean; deletedId: string }> {
  return apiFetch<{ success: boolean; deletedId: string }>(`/api/company-profiles/${profileId}`, {
    method: "DELETE",
  });
}

/** Legacy / deprecated single profile endpoints */
export async function getCompanyProfile(): Promise<CompanyProfileResponse> {
  return apiFetch<CompanyProfileResponse>("/api/company-profile");
}

export async function saveCompanyProfile(
  input: CompanyProfileInput,
): Promise<CompanyProfileResponse> {
  return apiFetch<CompanyProfileResponse>("/api/company-profile", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
