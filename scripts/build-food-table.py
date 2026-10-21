"""
Build worker/modules/health/food-table.json from the MEXT Excel
「日本食品標準成分表（八訂）増補2023年 第2章（データ）」.

  python3 scripts/build-food-table.py path/to/honpyo.xlsx

Columns are matched by INFOODS component identifier (row 12 of the sheet), not by position,
so a re-published file with re-ordered columns still converts correctly.
Values are per 100 g of edible portion. Notation in the source:
  "-"   not determined          -> null (unknown, never 0)
  "Tr"  trace                   -> 0
  "(0)" estimated zero          -> 0
  "(x)" estimated value         -> x
Source: 文部科学省「日本食品標準成分表（八訂）増補2023年」(政府標準利用規約 第2.0版 / CC BY 4.0 互換)
"""
import json, re, sys, unicodedata
import openpyxl

# app nutrient key -> INFOODS identifier
MAP = {
    "energy_kcal": "ENERC_KCAL", "protein_g": "PROT-", "fat_g": "FAT-", "carbs_g": "CHOCDF-",
    "fiber_g": "FIB-", "salt_g": "NACL_EQ", "calcium_mg": "CA", "iron_mg": "FE", "magnesium_mg": "MG",
    "zinc_mg": "ZN", "potassium_mg": "K", "vitamin_a_ug": "VITA_RAE", "vitamin_b1_mg": "THIA",
    "vitamin_b2_mg": "RIBF", "vitamin_b6_mg": "VITB6A", "vitamin_b12_ug": "VITB12", "vitamin_c_mg": "VITC",
    "vitamin_d_ug": "VITD", "vitamin_e_mg": "TOCPHA", "folate_ug": "FOL",
}
GROUPS = {1: "穀類", 2: "いも及びでん粉類", 3: "砂糖及び甘味類", 4: "豆類", 5: "種実類", 6: "野菜類", 7: "果実類", 8: "きのこ類",
          9: "藻類", 10: "魚介類", 11: "肉類", 12: "卵類", 13: "乳類", 14: "油脂類", 15: "菓子類", 16: "し好飲料類",
          17: "調味料及び香辛料類", 18: "調理済み流通食品類"}

def value(raw):
    if raw is None: return None
    s = unicodedata.normalize("NFKC", str(raw)).strip()
    if s in ("", "-", "−", "*"): return None
    if s.lower() == "tr" or s == "(Tr)": return 0.0
    s = s.strip("()").replace(",", "")
    try: return float(s)
    except ValueError: return None

def main(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[0]  # 表全体
    rows = ws.iter_rows(values_only=True)
    header = None
    foods = []
    for i, row in enumerate(rows):
        if header is None:
            if row and any(str(c).strip() == "ENERC_KCAL" for c in row if c is not None):
                header = {str(c).strip(): j for j, c in enumerate(row) if c is not None}
                missing = [v for v in MAP.values() if v not in header]
                if missing: sys.exit(f"identifiers not found: {missing}")
            continue
        number = row[1]
        name = row[3]
        if not number or not name: continue
        number = str(number).strip()
        if not re.fullmatch(r"\d{5}", number): continue
        name = unicodedata.normalize("NFKC", str(name)).replace("　", " ").strip()
        name = re.sub(r"\s+", " ", name)
        n = {}
        for key, ident in MAP.items():
            v = value(row[header[ident]])
            if v is not None: n[key] = v
        refuse = value(row[header["REFUSE"]]) if "REFUSE" in header else None
        foods.append({"n": number, "g": int(number[:2]), "name": name, "refuse": refuse, "per100g": n})
    out = {
        "source": "文部科学省「日本食品標準成分表（八訂）増補2023年」",
        "license": "政府標準利用規約（第2.0版）。CC BY 4.0 互換。出典を表示して利用。",
        "url": "https://www.mext.go.jp/a_menu/syokuhinseibun/mext_00001.html",
        "basis": "可食部100gあたり",
        "groups": GROUPS,
        "keys": list(MAP.keys()),
        "foods": foods,
    }
    dst = "worker/modules/health/food-table.json"
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(foods)} foods -> {dst}")

if __name__ == "__main__":
    main(sys.argv[1])
