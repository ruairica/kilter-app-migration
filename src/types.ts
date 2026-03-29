export interface ExportData {
  user: { username: string; email_address: string };
  ascents: Array<{
    climb: string;
    angle: number;
    count: number;
    stars: number;
    climbed_at: string;
    created_at: string;
    grade: string;
  }>;
  attempts: Array<{
    climb: string;
    angle: number;
    count: number;
    climbed_at: string;
    created_at: string;
  }>;
  circuits: Array<{
    name: string;
    color: string;
    created_at: string;
    is_private?: boolean;
    climbs: string[];
  }>;
}

export interface V2Climb {
  climbUuid: string;
  name: string;
  productLayoutUuid: string;
  [key: string]: unknown;
}

export interface GradeEntry {
  difficultyGradeId: number;
  fontScale: string;
  [key: string]: unknown;
}

export interface Gym {
  gym_uuid: string;
  name: string;
  city: string;
  country: string;
  [key: string]: unknown;
}

export interface Wall {
  wall_uuid: string;
  gym_uuid: string;
  product_layout_uuid: string;
  name: string;
  [key: string]: unknown;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
}
