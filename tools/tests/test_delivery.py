import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('delivery', Path(__file__).parents[1] / 'delivery.py')
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class DeliveryChecks(unittest.TestCase):
    def test_source_allowlist_includes_untracked_code_and_excludes_runtime(self):
        for name in ['server-node/src/private-storage.js', 'tools/delivery.py', 'docs/p4.md', 'SFT_Manual_Acceptance_P5.md', 'SecureFileTransfer.Client/SecureFileTransfer.Client/New.cs']:
            self.assertTrue(delivery.allowed_source(name))
        for name in delivery.REVIEWED_EVIDENCE_IMAGES:
            self.assertTrue(delivery.allowed_source(name))
        for name in ['.git/config', 'server-node/data/accounts.sqlite', 'server-node/certs/private/server.key', 'server-node/data/uploads/objects/a.bin',
                     'server-node/node_modules/pkg/index.js', 'SecureFileTransfer.Client/project/bin/Debug/test.cs', '.env', 'docs/key.pem',
                     '../outside.cs', '/outside.md', '实验 1 讲解 2026.pdf', 'artifacts/a.json',
                     'docs/evidence/unreviewed.png', 'docs/evidence/manual-20261124/private-key.jpg']:
            self.assertFalse(delivery.allowed_source(name))

    def test_safe_course_names(self):
        self.assertEqual(delivery.safe_component('姓名待填写'), '姓名待填写')
        for value in ['../escape', 'C:\\x', 'x/y', 'x\n', '']:
            with self.assertRaises(ValueError):
                delivery.safe_component(value)

    def test_manual_acceptance_does_not_claim_final_delivery(self):
        summary = {'passed': 27, 'conditionalNotCovered': ['D05']}
        info = {'guiAcceptanceCompleted': True, 'guiAcceptanceSummary': summary}
        gaps = ['real MP4 video missing', 'real PDF/DOCX report missing']
        result = delivery.candidate_status(info, gaps, 'actual-head')
        self.assertNotIn('pending manual acceptance', result['gui'])
        self.assertEqual(result['guiAcceptanceSummary'], summary)
        self.assertEqual(result['missing'], gaps)
        self.assertIn('不可作为最终作业提交', result['status'])
        self.assertEqual(delivery.candidate_status({}, gaps, 'actual-head')['gui'], 'pending manual acceptance')

    def test_generated_report_evidence_links_resolve_inside_source_folder(self):
        info = {'name': '姓名待填写', 'studentId': '学号待填写', 'repositoryUrl': '待填写真实Git仓库链接'}
        report = delivery.report_draft(info, 'candidate_src').decode('utf-8')
        self.assertIn('](candidate_src/docs/evidence/manual-20261124/image-1.png)', report)
        self.assertNotIn('](evidence/', report)

    def test_zip_hashes_no_encryption_and_no_overwrite(self):
        files = {'docs/example.md': b'example'}
        manifest = {'files': [{'path': name, 'bytes': len(data), 'sha256': delivery.sha(data)} for name, data in files.items()]}
        entries = {**files, 'SOURCE-MANIFEST.json': delivery.json_bytes(manifest)}
        with tempfile.TemporaryDirectory(prefix='sft-delivery-check-') as directory:
            archive = Path(directory) / 'snapshot.zip'
            result = delivery.write_archive(archive, entries)
            self.assertFalse(result['encrypted'])
            self.assertEqual(result['sourceFiles'], 1)
            with self.assertRaises(FileExistsError):
                delivery.write_archive(archive, entries)
            with zipfile.ZipFile(archive, 'a') as altered:
                altered.writestr('unlisted-secret.txt', b'not allowed')
            with self.assertRaises(ValueError):
                delivery.verify(archive)


if __name__ == '__main__':
    unittest.main()
