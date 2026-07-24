import time
import pandas as pd
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

filename = "/Users/kenoreiter/Downloads/namenforschung_export.csv"
base_url = "https://www.namenforschung.net/dfd/woerterbuch/liste/"
max_pages = 5000
all_data = []

print("Starte Seitenabruf...")

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        page.goto(base_url, wait_until="domcontentloaded")
        time.sleep(1)

        for page_num in range(1, max_pages + 1):
            target_url = f"{base_url}?tx_dfd_names%5Baction%5D=list&tx_dfd_names%5Bcontroller%5D=Names&tx_dfd_names%5Bpointer%5D={page_num}"

            response = page.goto(target_url, wait_until="domcontentloaded")
            
            if not response or response.status != 200:
                print(f"Seite {page_num} nicht erreichbar. Ende.")
                break

            soup = BeautifulSoup(page.content(), 'html.parser')
            rows = soup.find_all('tr')

            if not rows or len(rows) <= 1:
                print(f"Keine weiteren Einträge auf Seite {page_num}. Ende erreicht!")
                break

            added = 0
            for row in rows[1:]:
                cols = row.find_all('td')
                if len(cols) >= 3:
                    name = cols[0].text.strip()
                    rang = cols[1].text.strip()
                    haeufigkeit = cols[2].text.strip()
                    all_data.append({"Name": name, "Rang": rang, "Häufigkeit": haeufigkeit})
                    added += 1

            if added == 0:
                break

            # Zeigt JETZT jede 5. Seite an, damit Sie sehen, dass es läuft!
            if page_num % 5 == 0:
                print(f"-> Seite {page_num} geladen | Aktuell {len(all_data)} Namen gesammelt")

            time.sleep(0.1)

        browser.close()

except KeyboardInterrupt:
    print("\n\n[Meldung] Vom Benutzer abgebrochen (Ctrl+C). Speichere bisherige Daten...")

finally:
    if all_data:
        df = pd.DataFrame(all_data)
        df.to_csv(filename, index=False, encoding="utf-8-sig", sep=";")
        print(f"Erfolgreich {len(df)} Namen in '{filename}' gespeichert!")
    else:
        print("Keine Daten zum Speichern vorhanden.")