import type { Activity } from "./types";

export interface ActivityMeta {
  key: Activity;
  label: string;
  noun: string;
  /** OLED дэлгэц дээр харуулах нэр */
  short: string;
  color: string;
  soft: string;
  description: string;
}

export const ACTIVITIES: Record<Activity, ActivityMeta> = {
  sitting: { key: "sitting", noun: "Суух", label: "Сууж байна", short: "Суух", color: "#7c7c7c", soft: "#f1f1f1", description: "Тогтвортой байрлал, бага хурдатгал" },
  standing: { key: "standing", noun: "Зогсох", label: "Зогсож байна", short: "Зогсох", color: "#4a4a4a", soft: "#f1f1f1", description: "Босоо байрлал, бага хэлбэлзэл" },
  walking: { key: "walking", noun: "Алхах", label: "Алхаж байна", short: "Алхах", color: "#2a61fd", soft: "#eaf0ff", description: "Тогтмол давтамжтай хэлбэлзэл" },
  running: { key: "running", noun: "Гүйх", label: "Гүйж байна", short: "Гүйх", color: "#151515", soft: "#f1f1f1", description: "Өндөр далайц, өндөр давтамж" },
  lying: { key: "lying", noun: "Хэвтэх", label: "Хэвтэж байна", short: "Хэвтэх", color: "#b4b4b4", soft: "#f1f1f1", description: "Таталцлын тэнхлэг хэвтээ" },
  fall: { key: "fall", noun: "Уналт", label: "Уналт илэрлээ", short: "УНАЛТ!", color: "#FF3B30", soft: "#FFE9E7", description: "Огцом цохилт → хөдөлгөөнгүй" },
};

export const ACTIVITY_ORDER: Activity[] = ["sitting", "standing", "walking", "running", "lying", "fall"];

export const emptyDurations = (): Record<Activity, number> => ({
  sitting: 0, standing: 0, walking: 0, running: 0, lying: 0, fall: 0,
});
