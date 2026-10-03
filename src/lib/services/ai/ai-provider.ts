export interface AIPersonalizeLeadContext {
  username: string;
  fullName?: string | null;
  biography?: string | null;
  category?: string | null;
  followers?: number | null;
  isBusiness?: boolean | null;
}

export interface AIPersonalizeRequest {
  lead: AIPersonalizeLeadContext;
  template: string;
  campaignContext?: string;
}

export interface AIPersonalizeResponse {
  text: string;
  provider?: string;
}

export interface AIProvider {
  readonly name: string;
  generatePersonalizedMessage(
    request: AIPersonalizeRequest,
  ): Promise<AIPersonalizeResponse>;
}
