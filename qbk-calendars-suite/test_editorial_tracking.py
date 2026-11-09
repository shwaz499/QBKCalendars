import hashlib,io,json,tempfile,unittest
from pathlib import Path
from urllib.parse import urlsplit
from unittest.mock import patch
import birthday_tracking as b
from test_birthday_tracking import Fake
class Tests(unittest.TestCase):
 def manifest(self):return {'report_key_sha256':hashlib.sha256(b'private').hexdigest(),'recipients':['reader','test-reader'],'links':{'birthday':'https://www.qbksports.com/kids-birthdays'}}
 def test_pixel_report_and_existing_clicks(self):
  with tempfile.TemporaryDirectory() as folder,patch.object(b,'manifest',return_value=self.manifest()):
   p=Fake('');p.wfile=io.BytesIO();b.handle(p,urlsplit('/birthday-track/o/test/reader.gif'),folder)
   self.assertEqual(p.status,200);self.assertEqual(p.out['Content-Type'],'image/gif');self.assertEqual(p.wfile.getvalue(),b.PIXEL)
   click=Fake('');b.handle(click,urlsplit('/birthday-track/c/test/reader/birthday'),folder);self.assertEqual(click.status,302)
   report=Fake('',auth='Bearer private');b.handle(report,urlsplit('/birthday-track/report/test'),folder)
   self.assertEqual(len(report.body['events']),1);self.assertEqual(len(report.body['open_events']),1)
   self.assertEqual(set(report.body['open_events'][0]),{'campaign','recipient','created','suspected_bot','image_proxy'})
   bad=Fake('');b.handle(bad,urlsplit('/birthday-track/report/test'),folder);self.assertEqual(bad.status,401)
 def test_invalid_pixel_and_head_do_not_record(self):
  with tempfile.TemporaryDirectory() as folder,patch.object(b,'manifest',return_value=self.manifest()):
   for path in ('/birthday-track/o/test/unknown.gif','/birthday-track/o/test/reader.png'):
    h=Fake('');h.wfile=io.BytesIO();b.handle(h,urlsplit(path),folder);self.assertEqual(h.status,404)
   h=Fake('',command='HEAD');h.wfile=io.BytesIO();b.handle(h,urlsplit('/birthday-track/o/test/reader.gif'),folder)
   self.assertEqual(h.status,200);self.assertEqual(h.wfile.getvalue(),b'');self.assertFalse((Path(folder)/'birthday-opens.jsonl').exists())
 def test_automated_requests_labeled(self):
  with tempfile.TemporaryDirectory() as folder,patch.object(b,'manifest',return_value=self.manifest()):
   for ua in ('Proofpoint scanner','GoogleImageProxy'):
    h=Fake('');h.wfile=io.BytesIO();h.headers['User-Agent']=ua;b.handle(h,urlsplit('/birthday-track/o/test/reader.gif'),folder)
   rows=[json.loads(x) for x in (Path(folder)/'birthday-opens.jsonl').read_text().splitlines()]
   self.assertEqual(rows[0]['suspected_bot'],1);self.assertEqual(rows[1]['image_proxy'],1)
if __name__=='__main__':unittest.main()
