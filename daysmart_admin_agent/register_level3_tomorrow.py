import os, sys
from datetime import date, timedelta
from playwright.sync_api import sync_playwright

# Fill these once, or export env vars before running.
COMPANY = os.getenv('DAYSMART_COMPANY', 'qbksports')
USERNAME = os.getenv('DAYSMART_USERNAME', 'joshschwartztv')
PASSWORD = os.getenv('DAYSMART_PASSWORD', 'Noseyman499*')
CUSTOMER_NAME = os.getenv('TARGET_CUSTOMER_NAME', 'Josh Schwartz')
CUSTOMER_ID = os.getenv('TARGET_CUSTOMER_ID', '9511')
TARGET_DATE = date(2026, 2, 28)
DATE_ISO = TARGET_DATE.isoformat()
DATE_MMDD = TARGET_DATE.strftime('%m/%d')


def click_first(page, selectors, timeout=2500):
    for sel in selectors:
        loc = page.locator(sel)
        if loc.count() > 0:
            try:
                loc.first.click(timeout=timeout)
                return sel
            except Exception:
                pass
    return None


with sync_playwright() as p:
    browser = p.chromium.launch(headless=False, slow_mo=200)
    page = browser.new_page()

    page.goto('https://apps.daysmartrecreation.com/dash/admin/index.php?Action=Auth/login', wait_until='domcontentloaded')
    for sel, val in [
        ("input[placeholder='Company'],input[placeholder='Company Code'],input[name='company']", COMPANY),
        ("input[placeholder='Email'],input[name='email'],input[type='email'],input[name='username']", USERNAME),
        ("input[placeholder='Password'],input[type='password'],input[name='password']", PASSWORD),
    ]:
        try:
            page.locator(sel).first.fill(val)
        except Exception:
            pass
    click_first(page, ["button:has-text('Sign in')", "button[type='submit']", "text=Sign in"])
    page.wait_for_timeout(3000)

    page.goto(f'https://apps.daysmartrecreation.com/dash/admin/index.php?Action=CustomerSearch&company={COMPANY}', wait_until='domcontentloaded')
    page.locator("input[name='FirstName']").fill(CUSTOMER_NAME.split()[0])
    page.locator("input[name='LastName']").fill(CUSTOMER_NAME.split()[-1])
    click_first(page, ["input[name='Search'][type='submit']"])
    page.wait_for_timeout(2000)

    page.get_by_role('link', name=CUSTOMER_NAME, exact=True).first.click()
    page.wait_for_timeout(2000)

    click_first(page, ["button:has-text('Add')", "a:has-text('Add')", "#addFamilyDIV", "[data-bs-toggle='dropdown']"])
    page.wait_for_timeout(700)
    if not click_first(page, ["a.dropdown-item:has-text('Camp')", "a:has-text('Camp')"]):
        page.goto(f'https://apps.daysmartrecreation.com/dash/admin/index.php?Action=TeamModify&program_type_id=1&AddTeamMember={CUSTOMER_ID}&company={COMPANY}', wait_until='domcontentloaded')
    page.wait_for_timeout(2500)

    try:
        page.select_option("select[name='SeasonIDs[]']", value='102')
    except Exception:
        pass
    click_first(page, ["input[name='Search'][type='submit']"])
    page.wait_for_timeout(2500)

    if page.locator("a[href*='TeamID=8416']").count() > 0:
        page.locator("a[href*='TeamID=8416']").first.click()
    else:
        page.get_by_role('link', name='Adult Level III Class', exact=True).first.click()
    page.wait_for_timeout(3500)

    click_first(page, ["button:has-text('Add')", "input[value='Add']", "a:has-text('Add')"], timeout=1500)
    page.wait_for_timeout(1000)

    chosen = False
    for row_sel in [f"tr:has-text('{DATE_ISO}')", f"tr:has-text('{DATE_MMDD}')", f"li:has-text('{DATE_ISO}')", f"li:has-text('{DATE_MMDD}')"]:
        row = page.locator(row_sel)
        if row.count() > 0:
            cb = row.first.locator("input[type='checkbox']")
            if cb.count() > 0:
                try:
                    cb.first.check(force=True)
                    print('selected', row_sel)
                    chosen = True
                    break
                except Exception:
                    pass

    if not chosen:
        print('Could not find tomorrow slot automatically. Leaving browser open.')
        page.wait_for_timeout(300000)
        browser.close()
        sys.exit(2)

    click_first(page, ["button:has-text('Continue')", "input[value='Continue']", "a:has-text('Continue')"])
    page.wait_for_timeout(2500)

    click_first(page, ["button:has-text('Checkout')", "input[value='Checkout']", "a:has-text('Checkout')"], timeout=2000)
    page.wait_for_timeout(2000)

    processed = click_first(page, ["button:has-text('Process Checkout')", "input[value='Process Checkout']", "a:has-text('Process Checkout')"], timeout=1500)
    page.wait_for_timeout(2000)

    page.goto(f'https://apps.daysmartrecreation.com/dash/admin/index.php?Action=CustomerInfo&CustomerID={CUSTOMER_ID}', wait_until='domcontentloaded')
    page.wait_for_timeout(2000)
    txt = page.locator('body').inner_text(timeout=3000)
    print('verify_level3', 'Adult Level III Class' in txt)
    print('verify_tomorrow', (DATE_ISO in txt) or (DATE_MMDD in txt))
    print('processed_checkout', bool(processed))

    page.wait_for_timeout(8000)
    browser.close()
