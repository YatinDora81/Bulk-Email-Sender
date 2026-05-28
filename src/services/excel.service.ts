import * as XLSX from "xlsx";
import path from "path";

export interface RawContact {
  sno: number;
  name: string;
  email: string;
  title: string;
  company: string;
}

/** Picks the input Excel file based on STORAGE_NAME_PREFIX / EXCEL_FILE env. */
export function getExcelFileName(): string {
  const explicit = process.env.EXCEL_FILE?.trim();
  if (explicit) return explicit;
  return process.env.STORAGE_NAME_PREFIX ? "data-temp.xlsx" : "data.xlsx";
}

export function parseExcelFile(filename?: string): RawContact[] {
  const filePath = path.join(process.cwd(), filename || getExcelFileName());
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("No sheets found in Excel file");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error("Sheet is empty");
  const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  return data
    .map((row, index) => ({
      sno: Number(row["SNo"] ?? row["sno"] ?? row["S.No"] ?? row["S.No."] ?? index + 1),
      name: String(row["Name"] ?? row["name"] ?? "").trim(),
      email: String(row["Email"] ?? row["email"] ?? row["EMAIL"] ?? "").trim().toLowerCase(),
      title: String(row["Title"] ?? row["title"] ?? row["Designation"] ?? "").trim(),
      company: String(row["Company"] ?? row["company"] ?? row["Organization"] ?? "").trim(),
    }))
    .filter((c) => c.email && c.email.includes("@"));
}
