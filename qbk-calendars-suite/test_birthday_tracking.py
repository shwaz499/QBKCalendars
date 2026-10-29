import hashlib,json,tempfile,unittest
from pathlib import Path
from urllib.parse import urlsplit
from unittest.mock import patch
import birthday_tracking as b
class Fake:
 def __init__(self,path,auth='',command='GET'):self.headers={'Authorization':auth,'User-Agent':'Mozilla/5.0'};self.command=command;self.status=None;self.body=None;self.out={}
 def _send_json(self,body,status=200,**kw):self.status=status;self.body=body
 def send_response(self,status):self.status=status
 def send_header(self,k,v):self.out[k]=v
 def end_headers(self):pass
class Tests(unittest.TestCase):
 def test_redirect_storage_auth_and_invalid_inputs(self):
  m={'report_key_sha256':hashlib.sha256(b'private').hexdigest(),'recipients':['abc'],'links':{'def':'https://www.qbksports.com/kids-birthdays'}}
  with tempfile.TemporaryDirectory() as folder,patch.object(b,'manifest',return_value=m):
   h=Fake('');self.assertTrue(b.handle(h,urlsplit('/birthday-track/c/test/abc/def'),folder));self.assertEqual(h.status,302);self.assertEqual(h.out['Location'],m['links']['def'])
   h=Fake('');b.handle(h,urlsplit('/birthday-track/report/test'),folder);self.assertEqual(h.status,401)
   h=Fake('',auth='Bearer private');b.handle(h,urlsplit('/birthday-track/report/test'),folder);self.assertEqual(len(h.body['events']),1)
   h=Fake('');b.handle(h,urlsplit('/birthday-track/c/test/wrong/def'),folder);self.assertEqual(h.status,404)
   m['links']['def']='https://evil.example/';h=Fake('');b.handle(h,urlsplit('/birthday-track/c/test/abc/def'),folder);self.assertEqual(h.status,404)
 def test_unrelated_route_untouched(self):self.assertFalse(b.handle(Fake(''),urlsplit('/api/replay-analytics'),'/tmp'))
if __name__=='__main__':unittest.main()
