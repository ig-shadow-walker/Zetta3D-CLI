/**
 * Response and request shapes of the Zetta 3D API, as the backend serialises them.
 *
 * Dates arrive as ISO strings. Fields the server may add later are tolerated: nothing here
 * is used to reject a response.
 */

export type PaymentPlan = 'none' | 'free' | 'tester' | 'basic' | 'creator' | 'creator_pro' | 'enterprise'

export interface CreditPool {
  monthly: number
  purchased: number
  bonusMonthly: number
  bonus: number
}

export interface PublicUser {
  id: number
  email: string
  displayName: string | null
  profilePicture: string | null
  emailVerified: boolean
  isBusiness: boolean
  googleConnected: boolean
  paymentPlan: PaymentPlan
  subscriptionStatus: string | null
  isZettaAdmin: boolean
  earlyAccess: boolean
  onboardingCompletedAt: string | null
  credits: { threeD: CreditPool; ai: CreditPool }
  createdAt: string
}

export interface MeResponse {
  user: PublicUser
  onboardingBonus: unknown
}

export interface VerifyResponse {
  user: PublicUser
  newAccount: boolean
}

export interface PluginTokenResponse {
  token: string
  expiresInDays: number
  user: PublicUser
}

export interface OnboardingAnswers {
  userType: string
  industry: string
  industryOther?: string
  tools: string[]
  engines: string[]
  heardFrom?: string
}

// ── Billing ────────────────────────────────────────────────────────────────

export interface PricingResponse {
  plans: Array<Record<string, unknown> & { plan: string; name: string }>
  freePlan: Record<string, unknown> | null
  creditPacks: Array<Record<string, unknown> & { priceId?: string; credits?: number }>
  operations: Array<Record<string, unknown>>
}

export interface Subscription {
  plan: string
  status: string | null
  priceId: string | null
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: string | null
  manageable: boolean
}

export interface UsageEntry {
  id: number
  meter: 'three_d_credit' | 'ai_token' | string
  entryType: 'debit' | 'refund' | string
  bucket: string
  operationType: string | null
  amount: number
  subjectType: string | null
  subjectId: number | string | null
  reason: string | null
  userPaymentPlan: string | null
  createdAt: string
}

export interface UsagePage {
  entries: UsageEntry[]
  nextCursor: string | null
}

// ── 3D catalogue ───────────────────────────────────────────────────────────

export interface PriceListItem {
  code: string
  kind: string
  label: string
  credits: number
  model: string | null
}

export interface ThreeDEntitlementsResponse {
  plan: string
  entitlements: Record<string, unknown>
}

export interface ImageEntitlementsResponse {
  plan: string
  entitlements: { allowsImageEditing: boolean; allows4kImages: boolean; allowsProImageModel: boolean }
}

export interface ImageModel {
  id: string
  label: string
  resolutions: string[]
  locked?: boolean
  lockedReason?: string | null
}

export interface QuoteLine {
  code: string
  label: string
  credits: number
}

export interface Quote {
  credits: number
  lines: QuoteLine[]
}

// ── 3D generations (library assets) ────────────────────────────────────────

export type GenerationStatus = 'pending' | 'queued' | 'processing' | 'saving' | 'success' | 'failed' | 'cancelled'

export const TERMINAL_STATUSES: readonly GenerationStatus[] = ['success', 'failed', 'cancelled']

export interface ResultFile {
  type: string
  folder?: string
  key: string
  url: string
  bytes?: number
  label?: string
}

export interface GenerationResult {
  model?: string
  files: ResultFile[]
  thumbnail?: { key: string; url: string }
}

export interface Generation {
  id: number
  status: GenerationStatus
  selectedFeature: string
  selectedModel: string | null
  jobSpec: unknown
  title: string | null
  tags: string[] | null
  pipelineRunId: number | null
  availability: 'public' | 'private' | string
  inputPrompt: string | null
  inputImages: Array<{ url: string; viewType?: string | null }>
  thumbnailURL: string | null
  isFeatured?: boolean
  faceCount: number | null
  polygonType: string | null
  result: GenerationResult | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  runGroup?: unknown
}

export interface GenerationDetail {
  generation: Generation
  queuePosition: number | null
}

export interface CreateGenerationResponse {
  generation: Generation
  quote: Quote
  charged: boolean
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ListGenerationsQuery {
  page?: number
  pageSize?: number
  status?: GenerationStatus | GenerationStatus[]
  feature?: string
  search?: string
  availability?: 'public' | 'private'
  groupRuns?: boolean
  sortBy?: 'createdAt' | 'updatedAt'
  sortDir?: 'ASC' | 'DESC'
}

export interface UpdateGenerationInput {
  title?: string
  tags?: string[]
  availability?: 'public' | 'private'
}

export interface DownloadLink {
  key: string
  url: string
  expiresInSeconds: number
}

// ── Uploads ────────────────────────────────────────────────────────────────

export interface UploadTicket {
  uploadUrl: string
  method: 'PUT' | string
  headers: Record<string, string>
  key: string
  fileUrl: string
  expiresAt?: string
}

export interface ResultUploadTicket {
  uploadUrl: string
  method: string
  headers: Record<string, string>
  key: string
}

// ── 2D images ──────────────────────────────────────────────────────────────

export interface ImageData {
  base64: string
  contentType: string
  bytes: number
}

export interface ImageResult {
  postId: number
  images: ImageData[]
  text: string | null
  model: string
}

export interface ImagePost {
  id: number
  feature: 'genImg' | 'editImg' | 'composeImg' | string
  prompt: string | null
  aspectRatio: string | null
  resolution: string | null
  images: Array<{ url: string; contentType: string; bytes: number }>
  errorMessage: string | null
  createdAt: string
}

export interface InlineImage {
  data: string
  contentType: string
}

export interface GenerateImageInput {
  prompt: string
  aspectRatio?: string
  resolution?: '1K' | '2K' | '4K'
  model?: string
  for3D?: boolean
  subject?: 'object' | 'environment'
  fast?: boolean
  styleReferences?: InlineImage[]
}

export interface EditImageInput {
  prompt: string
  image?: InlineImage
  sourcePostId?: number
  aspectRatio?: string
  resolution?: '1K' | '2K' | '4K'
  model?: string
  for3D?: boolean
  subject?: 'object' | 'environment'
  pipelineStep?: boolean
  textureMap?: boolean
}

export interface ComposeImageInput {
  prompt: string
  images?: InlineImage[]
  sourcePostIds?: number[]
  aspectRatio?: string
  resolution?: '1K' | '2K' | '4K'
  model?: string
}

// ── Tools ──────────────────────────────────────────────────────────────────

export interface RembgResult {
  image: string
  contentType: string
  bytes: number
}

export interface Frame {
  data: string
  mediaType: string
}

export interface TagsResult {
  category: string
  tags: string[]
  tokens: number
  estimatedTokens: number
}

export interface RiggingPrecheck {
  bodyType: string
  confidence: string
  reason: string
}

// ── Early access ───────────────────────────────────────────────────────────

export interface EarlyAccessResult {
  status: 'pending' | 'approved' | 'granted' | string
  email: string
}
