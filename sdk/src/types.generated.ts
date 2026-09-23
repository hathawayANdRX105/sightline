/**
 * 自动生成的 Sightline 类型（来自 src/schema.rs 的 specta 派生）。
 *
 * !!! 不要手改此文件 !!!
 *
 * 生成方式（见 docs/architecture.md §10.3）:
 *   cd <repo>
 *   cargo run --bin generate-types   # （待实现，见下）
 *
 * 当前文件是 **手写占位** —— 跟 src/schema.rs 字段一一对应，待 M0 收尾
 * 时被 specta-typescript 自动生成的版本替换。
 */

export type UUID = string;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  userAgent?: string;
  capturedAt?: string;
  viewport: Viewport;
}

export interface DomContextNode {
  tagName: string;
  attributes: Record<string, string>;
  text?: string;
}

export interface NearbyText {
  before: string;
  after: string;
}

export interface TextSelection {
  exact: string;
  prefix: string;
  suffix: string;
  truncated: boolean;
  rects: Rect[];
}

export interface TargetSnapshot {
  id: UUID;
  selector: string;
  tagName: string;
  text: string;
  attributes: Record<string, string>;
  rect: Rect;
  styles: Record<string, string>;
  ancestors?: DomContextNode[];
  ancestryTruncated?: boolean;
  nearbyText?: NearbyText;
  nearbyElements?: DomContextNode[];
  textSelection?: TextSelection;
}

export interface Annotation {
  id: UUID;
  comment: string;
  createdAt: string;
  page: PageSnapshot;
  targets: TargetSnapshot[];
}

export interface FeedbackDocument {
  schemaVersion: number;
  sessionId: UUID;
  version: number;
  annotations: Annotation[];
  updatedAt: string;
}

export interface SyncRequest {
  sessionId: UUID;
  baseVersion: number;
  upsertAnnotations: Annotation[];
  /** 要删除的标注 id。先于 upsert 应用（同 id 同时出现时 upsert 生效）。 */
  removeAnnotationIds: UUID[];
}
