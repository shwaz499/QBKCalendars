"""Birthday click collection; only opaque IDs are hosted. Report requires per-campaign key."""
import hashlib,hmac,json,re,threading
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlsplit
LOCK=threading.Lock()
MANIFESTS=Path(__file__).resolve().parent/'birthday-manifests'

def manifest(campaign):
 if not re.fullmatch(r'[a-z0-9-]{1,80}',campaign):raise ValueError()
 return json.loads((MANIFESTS/(campaign+'.json')).read_text())

def destination(m,lid):
 url=m['links'].get(lid);u=urlsplit(url or '')
 if u.scheme!='https' or u.username or u.password or u.hostname not in {'www.qbksports.com','qbksports.com','www.instagram.com','www.facebook.com','www.tiktok.com','spearcenter.com'}:raise ValueError()
 return url

def handle(handler,parsed,data_dir):
 if not parsed.path.startswith('/birthday-track/'):return False
 handler._cache_control='no-store'
 parts=parsed.path.strip('/').split('/')
 try:
  if len(parts)==3 and parts[1]=='report':
   m=manifest(parts[2]);auth=handler.headers.get('Authorization','')
   if not auth.startswith('Bearer ') or not hmac.compare_digest(hashlib.sha256(auth[7:].encode()).hexdigest(),m['report_key_sha256']):
    handler._send_json({'error':'Unauthorized'},status=401,cache_control='no-store');return True
   path=Path(data_dir)/'birthday-clicks.jsonl';rows=[]
   with LOCK:
    if path.exists():
     for raw in path.open():
      try:e=json.loads(raw)
      except ValueError:continue
      if e.get('campaign')==parts[2]:rows.append(e)
   handler._send_json({'events':rows,'storage':'persistent_file' if str(data_dir)=='/var/data' else 'local_file'},cache_control='no-store');return True
  if len(parts)!=5 or parts[1]!='c':raise ValueError()
  _,_,campaign,rid,lid=parts;m=manifest(campaign)
  if rid not in m['recipients']:raise ValueError()
  url=destination(m,lid)
  if handler.command=='GET':
   ua=handler.headers.get('User-Agent','').lower()
   bot=not ua or any(x in ua for x in ('bot','crawler','spider','scanner','proofpoint','barracuda','mimecast','safelinks'))
   event={'campaign':campaign,'recipient':rid,'link':lid,'created':datetime.now(timezone.utc).isoformat(),'suspected_bot':int(bot)}
   with LOCK:
    path=Path(data_dir)/'birthday-clicks.jsonl';path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('a') as f:f.write(json.dumps(event,separators=(',',':'))+'\n')
  handler.send_response(302);handler.send_header('Location',url);handler.send_header('Referrer-Policy','no-referrer');handler.send_header('Cache-Control','no-store');handler.end_headers()
 except (ValueError,KeyError,FileNotFoundError,TypeError):handler._send_json({'error':'Not found'},status=404,cache_control='no-store')
 except Exception:handler._send_json({'error':'Tracking unavailable'},status=503,cache_control='no-store')
 return True
