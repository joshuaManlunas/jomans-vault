"""Contract regressions against a strict fake glab; never contacts a forge."""
import json
import importlib.util
from importlib.machinery import SourceFileLoader
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

REPO = Path(__file__).resolve().parents[2]
PROJECT = 'team/sub/project'
HOST = 'gitlab.example.test'
P = 'projects/team%2Fsub%2Fproject'
URL = f'https://{HOST}/{PROJECT}/-/'
SHA = 'a' * 40
DATE = '2026-01-02T00:00:00Z'

FAKE_GLAB = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
args = sys.argv[1:]
with open(os.environ['FAKE_GLAB_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\n')
path = Path(os.environ['FAKE_GLAB_RESPONSES'])
responses = json.loads(path.read_text())
if not responses:
    sys.exit('unexpected glab call: ' + repr(args))
expected = responses.pop(0)
if args != expected['args']:
    sys.exit('unexpected glab call: ' + repr(args) + '\nexpected: ' + repr(expected['args']))
path.write_text(json.dumps(responses))
if expected.get('error'):
    sys.exit(expected['error'])
if 'raw' in expected:
    print(expected['raw'])
else:
    print(json.dumps(expected['response']))
'''


def api(path, response=None, method='GET', paginate=False, error=None, **fields):
    args = ['api', path, '--hostname', HOST, '-X', method]
    if paginate:
        args += ['--paginate']
    for name, value in fields.items():
        args += ['-F' if isinstance(value, bool) else '-f',
                 name + '=' + (str(value).lower() if isinstance(value, bool) else str(value))]
    return {'args': args, 'response': response, **({'error': error} if error else {})}


def issue(state='opened'):
    return {'id': 901, 'iid': 7, 'title': 'A request', 'description': 'Build this',
            'author': {'username': 'author'}, 'labels': ['factory'], 'state': state,
            'web_url': URL + 'issues/7'}


def mr(**changes):
    return {'id': 902, 'iid': 9, 'web_url': URL + 'merge_requests/9', 'state': 'opened',
            'title': 'Draft: Work', 'draft': True, 'sha': SHA, 'source_branch': 'factory/work',
            'target_branch': 'main', **changes}


def project(method='merge', squash='default_off', project_access=30, group_access=None):
    return {'path_with_namespace': PROJECT, 'web_url': f'https://{HOST}/{PROJECT}',
            'default_branch': 'main', 'merge_method': method, 'squash_option': squash,
            'permissions': {'project_access': {'access_level': project_access} if project_access else None,
                            'group_access': {'access_level': group_access} if group_access else None}}


def note(body='Review', author='review-bot[bot]', **changes):
    return {'id': 11, 'body': body, 'author': {'username': author},
            'created_at': '2026-01-03T00:00:00Z', 'system': False, **changes}


def discussion(resolved=False, **changes):
    return {'id': 'thread-1', 'notes': [note(resolvable=True, resolved=resolved,
            position={'head_sha': SHA, 'new_path': 'demo/a.py', 'new_line': 12}, **changes)]}


class GitLabContractTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.factory = self.root / 'factory'
        (self.factory / 'bin').mkdir(parents=True)
        for name in ('forge', 'job'):
            shutil.copy2(REPO / 'factory/bin' / name, self.factory / 'bin' / name)
        self.config = json.loads((REPO / 'factory/config.json').read_text())
        self.config.update(forge={'type': 'gitlab', 'host': HOST, 'project': PROJECT},
                           base_branch='main', concurrency=3)
        (self.factory / 'config.json').write_text(json.dumps(self.config))
        fake = self.root / 'fake-bin'
        fake.mkdir()
        for name, body in [('glab', FAKE_GLAB), ('gh', '#!/bin/sh\necho "unexpected gh call" >&2\nexit 1\n')]:
            path = fake / name
            path.write_text(body)
            path.chmod(0o755)
        self.responses = self.root / 'responses.json'
        self.log = self.root / 'glab.jsonl'
        self.env = {**os.environ, 'PATH': str(fake) + os.pathsep + os.environ['PATH'],
                    'FAKE_GLAB_RESPONSES': str(self.responses), 'FAKE_GLAB_LOG': str(self.log),
                    'CLAUDE_CONFIG_DIR': str(self.root / 'claude')}

    def command(self, args, responses, expected=None, body=None, code=0, executable='forge'):
        self.responses.write_text(json.dumps(responses))
        result = subprocess.run([sys.executable, str(self.factory / 'bin' / executable), *args],
                                cwd=self.root, env=self.env, input=body, capture_output=True, text=True)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        self.assertEqual(json.loads(self.responses.read_text()), [], result.stdout + result.stderr)
        if code == 0 and executable == 'forge':
            self.assertEqual(json.loads(result.stdout) if result.stdout.strip() else None, expected)
        return result

    def test_every_issue_command_uses_project_iids_and_documented_rest_fields(self):
        cases = [
            (['whoami'], [api('user', {'username': 'operator[bot]'})], {'login': 'operator'}, None),
            (['issue-list', '--label', 'factory', '--state', 'open'],
             [api(P + '/issues?labels=factory&state=opened', [issue()], paginate=True)],
             [{'number': 7, 'title': 'A request'}], None),
            (['issue-create', '--title', 'New', '--label', 'factory', '--label', 'triaged'],
             [api(P + '/issues', issue(), 'POST', title='New', labels='factory,triaged', description='@body\ntext')],
             {'number': 7, 'url': URL + 'issues/7'}, '@body\ntext'),
            (['issue-comment', '7'], [api(P + '/issues/7/notes', {}, 'POST', body='@codex review')], None, '@codex review'),
            (['issue-labels', '7', '--add', 'a,b', '--remove', 'factory'],
             [api(P + '/issues/7', {}, 'PUT', add_labels='a,b', remove_labels='factory')], None, None),
            (['issue-close', '7'], [api(P + '/issues/7', {}, 'PUT', state_event='close')], None, None),
            (['issue-link-child', '7', '8'], [api(P + '/issues/7/links', {}, 'POST',
              target_project_id=PROJECT, target_issue_iid=8, link_type='relates_to')], None, None),
            (['label-ensure', 'factory', '#abcdef', 'Queue'],
             [api(P + '/labels', [], paginate=True), api(P + '/labels', {}, 'POST', name='factory', color='#abcdef', description='Queue')], None, None),
            (['label-ensure', 'factory', '#abcdef', 'Queue'],
             [api(P + '/labels', [{'name': 'factory'}], paginate=True)], None, None),
        ]
        for args, responses, expected, body in cases:
            with self.subTest(command=args):
                self.command(args, responses, expected, body)

    def test_issue_view_normalizes_state_and_excludes_system_notes(self):
        for state, normalized in [('opened', 'OPEN'), ('closed', 'CLOSED')]:
            with self.subTest(state=state):
                self.command(['issue-view', '7'], [api(P + '/issues/7', issue(state)),
                    api(P + '/issues/7/notes?sort=asc&order_by=created_at',
                        [note('A comment', author='author'), note('closed', system=True)], paginate=True)],
                    {'number': 7, 'url': URL + 'issues/7', 'title': 'A request', 'body': 'Build this',
                     'author': 'author', 'labels': ['factory'], 'state': normalized,
                     'comments': [{'author': 'author', 'body': 'A comment', 'created_at': '2026-01-03T00:00:00Z'}]})

    def test_related_issue_link_failure_is_best_effort(self):
        result = self.command(['issue-link-child', '7', '8'], [api(P + '/issues/7/links', method='POST',
            target_project_id=PROJECT, target_issue_iid=8, link_type='relates_to', error='unsupported')])
        self.assertIn("couldn't link #8", result.stderr)

    def test_pr_branch_filters_and_state_mapping_do_not_leak_global_ids(self):
        for state, query in [('open', 'opened'), ('all', 'all')]:
            with self.subTest(state=state):
                path = P + '/merge_requests?' + urlencode({'source_branch': 'factory/work', 'state': query})
                self.command(['pr-for-branch', 'factory/work', '--state', state],
                    [api(path, [mr(), mr(state='merged'), mr(state='closed')], paginate=True)],
                    [{'number': 9, 'url': URL + 'merge_requests/9', 'state': s} for s in ('OPEN', 'MERGED', 'CLOSED')])

    def test_pr_view_uses_sha_when_diff_refs_are_empty_and_accepts_legacy_draft(self):
        for changes, state, draft, head in [({}, 'OPEN', True, SHA),
            ({'state': 'merged', 'draft': False, 'work_in_progress': False}, 'MERGED', False, SHA),
            ({'state': 'closed', 'draft': None, 'work_in_progress': True}, 'CLOSED', True, SHA),
            ({'sha': None, 'diff_refs': {'head_sha': 'b' * 40}}, 'OPEN', True, 'b' * 40)]:
            with self.subTest(changes=changes):
                self.command(['pr-view', '9'], [api(P + '/merge_requests/9', mr(**changes))],
                    {'number': 9, 'url': URL + 'merge_requests/9', 'state': state, 'draft': draft,
                     'head_sha': head, 'head_branch': 'factory/work', 'base_branch': 'main'})

    def test_pr_create_draft_ready_comment_and_close_use_rest_not_cli_shortcuts(self):
        cases = [
            (['pr-create', '--base', 'main', '--head', 'factory/work', '--title', 'Work', '--draft'],
             [api(P + '/merge_requests', mr(), 'POST', target_branch='main', source_branch='factory/work',
                  title='Draft: Work', description='Closes #7')], {'number': 9, 'url': URL + 'merge_requests/9'}, 'Closes #7'),
            (['pr-ready', '9'], [api(P + '/merge_requests/9', mr()),
              api(P + '/merge_requests/9', {}, 'PUT', title='Work')], None, None),
            (['pr-ready', '9'], [api(P + '/merge_requests/9', mr(draft=False))], None, None),
            (['pr-comment', '9'], [api(P + '/merge_requests/9/notes', {}, 'POST', body='A comment')], None, 'A comment'),
            (['pr-close', '9'], [api(P + '/merge_requests/9', {}, 'PUT', state_event='close')], None, None),
        ]
        for args, responses, expected, body in cases:
            with self.subTest(command=args):
                self.command(args, responses, expected, body)

    def test_ready_removes_supported_draft_and_legacy_wip_title_prefixes(self):
        for title in ('[Draft] Work', '(Draft) Work', 'Draft: Work', 'WIP: Work', '[WIP] Work'):
            with self.subTest(title=title):
                self.command(['pr-ready', '9'], [api(P + '/merge_requests/9', mr(title=title)),
                             api(P + '/merge_requests/9', {}, 'PUT', title='Work')])

    def test_merge_honors_project_strategy_and_sends_boolean_squash_and_head_guard(self):
        for method, strategy, squash in [('merge', 'merge', False), ('merge', 'rebase_merge', False),
                                          ('squash', 'merge', True), ('rebase', 'ff', False), ('squash', 'ff', True)]:
            with self.subTest(method=method, strategy=strategy):
                self.command(['pr-merge', '9', '--method', method], [api(P, project(strategy)),
                    api(P + '/merge_requests/9', mr()), api(P + '/merge_requests/9/merge',
                    {'state': 'merged'}, 'PUT', squash=squash, sha=SHA)])

    def test_merge_refuses_unsupported_strategy_and_nonmerged_success_response(self):
        result = self.command(['pr-merge', '9', '--method', 'rebase'], [api(P, project())], code=1)
        self.assertIn('unavailable', result.stderr)
        result = self.command(['pr-merge', '9', '--method', 'merge'], [api(P, project()),
            api(P + '/merge_requests/9', mr()), api(P + '/merge_requests/9/merge', {'state': 'opened'},
                'PUT', squash=False, sha=SHA)], code=1)
        self.assertIn('did not merge', result.stderr)

    def test_repo_derives_merge_methods_and_developer_access_from_project_or_group(self):
        cases = [('merge', 'default_off', 30, None, ['merge', 'squash'], True),
                 ('rebase_merge', 'default_on', 20, 40, ['merge', 'squash'], True),
                 ('ff', 'never', 20, None, ['rebase'], False),
                 ('merge', 'always', None, None, ['squash'], False),
                 ('ff', 'always', 50, None, ['squash'], True),
                 ('merge', 'never', 29, None, ['merge'], False)]
        for strategy, squash, direct, group, methods, push in cases:
            with self.subTest(strategy=strategy, squash=squash, direct=direct, group=group):
                self.command(['repo'], [api(P, project(strategy, squash, direct, group))],
                    {'project': PROJECT, 'url': f'https://{HOST}/{PROJECT}', 'default_branch': 'main',
                     'merge_methods': methods, 'can_push': push})

    def test_threads_include_only_resolvable_discussions_and_filter_resolved_threads(self):
        data = [discussion(), {'id': 'done', 'notes': discussion(True)['notes']},
                {'id': 'plain', 'notes': [note(resolvable=False)]},
                {'id': 'system', 'notes': [note(system=True, resolvable=True)]}]
        expected = {'id': 'thread-1', 'resolved': False, 'path': 'demo/a.py', 'line': 12,
                    'author': 'review-bot', 'body': 'Review', 'url': URL + 'merge_requests/9#note_11', 'comment_id': 11}
        for unresolved in (False, True):
            with self.subTest(unresolved=unresolved):
                self.command(['threads', '9'] + (['--unresolved'] if unresolved else []),
                    [api(P + '/merge_requests/9/discussions', data, paginate=True)],
                    [expected] + ([] if unresolved else [{**expected, 'id': 'done', 'resolved': True}]))

    def test_discussion_is_unresolved_if_any_resolvable_note_is_unresolved(self):
        data = discussion(True)
        data['notes'].append(note(id=12, resolvable=True, resolved=False))
        result = self.command(['threads', '9', '--unresolved'],
            [api(P + '/merge_requests/9/discussions', [data], paginate=True)],
            [{'id': 'thread-1', 'resolved': False, 'path': 'demo/a.py', 'line': 12, 'author': 'review-bot',
              'body': 'Review', 'url': URL + 'merge_requests/9#note_11', 'comment_id': 11}])
        self.assertTrue(result.stdout)

    def test_thread_reply_and_resolve_stay_inside_discussion(self):
        self.command(['thread-reply', '9', 'thread-1'],
                     [api(P + '/merge_requests/9/discussions/thread-1/notes', {}, 'POST', body='Fixed')], body='Fixed')
        self.command(['thread-resolve', '9', 'thread-1'],
                     [api(P + '/merge_requests/9/discussions/thread-1', {}, 'PUT', resolved=True)])

    def test_bot_review_requires_evidence_tied_to_the_commit_not_a_newer_timestamp(self):
        # A late review of the previous commit must not pass the gate for a new one.
        marker = '<!-- codex-review-state:v1 ' + json.dumps({'code_review': {'commit_sha': SHA, 'status': 'completed'},
                                                         'nested': {'text': 'brace }'}}) + ' -->'
        cases = [
            ('matching diff', note(position={'head_sha': SHA}), [], True),
            ('wrong diff', note(position={'head_sha': 'b' * 40}), [], False),
            ('newer nondiff without the sha', note(created_at='2026-03-01T00:00:00Z'), [], False),
            ('summary naming the sha', note('Reviewed commit ' + SHA[:10]), [], True),
            ('summary naming another sha', note('Reviewed commit ' + 'b' * 10), [], False),
            ('sha prefix too short', note('Reviewed ' + SHA[:7]), [], False),
            ('codex marker', note(marker), [], True),
            ('incomplete marker', note(marker.replace('completed', 'pending')), [], False),
            ('other author', note('Reviewed ' + SHA, author='someone-else'), [], False),
            ('system note', note('Reviewed ' + SHA, system=True), [], False),
            ('diff in discussion', None, [discussion()], True),
        ]
        for name, n, discussions, reviewed in cases:
            with self.subTest(case=name):
                self.command(['bot-reviewed', '9', 'review-bot[bot]', SHA],
                    [api(P + '/merge_requests/9/notes', [n] if n else [], paginate=True),
                     api(P + '/merge_requests/9/discussions', discussions, paginate=True)], {'reviewed': reviewed})

    def test_paginated_glab_output_accepts_aggregated_or_concatenated_arrays(self):
        for raw in ('[{"iid":7,"title":"A"},{"iid":8,"title":"B"}]',
                    '[{"iid":7,"title":"A"}]\n[{"iid":8,"title":"B"}]'):
            with self.subTest(raw=raw):
                response = api(P + '/issues?labels=factory&state=opened', paginate=True)
                response['raw'] = raw
                self.command(['issue-list', '--label', 'factory'], [response],
                             [{'number': 7, 'title': 'A'}, {'number': 8, 'title': 'B'}])

    def test_gitlab_job_queue_and_create_quote_trusted_issue_notes_using_only_glab(self):
        result = self.command(['queue'], [api(P + '/issues?labels=factory&state=opened', [issue()], paginate=True)], executable='job')
        self.assertIn('new\t7\t-\t-\tA request', result.stdout)
        notes = [note('Author reply', author='author'), note('Operator reply', author='operator'),
                 note('Untrusted reply', author='outsider'), note('System reply', author='author', system=True)]
        reads = [api(P + '/issues/7', issue()),
                 api(P + '/issues/7/notes?sort=asc&order_by=created_at', notes, paginate=True)]
        result = self.command(['create', '7'], reads + reads + [api('user', {'username': 'operator'})], executable='job')
        job_id = result.stdout.strip()
        state = json.loads((self.factory / 'jobs' / job_id / 'job.json').read_text())
        self.assertEqual((state['issue'], state['issue_url'], state['pr'], state['pr_url']), (7, URL + 'issues/7', None, None))
        text = (self.factory / 'jobs' / job_id / 'issue.md').read_text()
        self.assertIn('> Build this', text)
        self.assertIn('> Author reply', text)
        self.assertIn('> Operator reply', text)
        self.assertNotIn('Untrusted reply', text)
        self.assertNotIn('System reply', text)
        self.assertIn('quoted data from the forge', text)

    def test_help_exposes_every_contract_command_without_contacting_a_provider(self):
        commands = ['whoami', 'repo', 'issue-list', 'issue-view', 'issue-create', 'issue-comment', 'issue-labels',
                    'issue-close', 'issue-link-child', 'label-ensure', 'pr-for-branch', 'pr-view', 'pr-create',
                    'pr-ready', 'pr-comment', 'pr-merge', 'pr-close', 'threads', 'thread-reply', 'thread-resolve', 'bot-reviewed']
        self.responses.write_text('[]')
        result = subprocess.run([sys.executable, str(self.factory / 'bin/forge'), '--help'],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for command in commands:
            self.assertIn(command, result.stdout)
        self.assertFalse(self.log.exists())


class GitHubAdapterTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_loader('test_factory_forge', SourceFileLoader(
            'test_factory_forge', str(REPO / 'factory/bin/forge')))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.backend = self.module.load({'forge': {'type': 'github', 'project': 'test/repo'}}, REPO)

    def test_missing_forge_config_resolves_github_project_with_legacy_repo_view(self):
        backend = self.module.load({}, REPO)
        self.assertIsInstance(backend, self.module.GitHub)
        with patch.object(backend, 'gh', return_value='{"nameWithOwner":"origin/repo"}') as command:
            self.assertEqual(backend.project_path(), 'origin/repo')
            self.assertEqual(backend.project_path(), 'origin/repo')
        command.assert_called_once_with('repo', 'view', '--json', 'nameWithOwner')

    def test_github_repo_normalizes_allowed_merge_methods_and_push_permission(self):
        data = {'full_name': 'test/repo', 'html_url': 'https://github.com/test/repo',
                'default_branch': 'trunk', 'allow_merge_commit': False, 'allow_squash_merge': True,
                'allow_rebase_merge': True, 'permissions': {'push': True}}
        with patch.object(self.backend, 'gh', return_value=json.dumps(data)) as command:
            self.assertEqual(self.backend.repo(), {'project': 'test/repo', 'url': data['html_url'],
                'default_branch': 'trunk', 'merge_methods': ['squash', 'rebase'], 'can_push': True})
        command.assert_called_once_with('api', 'repos/{owner}/{repo}')

    def test_github_label_ensure_reads_every_page_and_creates_only_missing_label(self):
        for pages, creates in [([[], [{'name': 'factory'}]], False), ([[], []], True)]:
            with self.subTest(pages=pages):
                with patch.object(self.backend, 'gh', side_effect=[json.dumps(pages), '']) as command:
                    self.backend.label_ensure('factory', '#abcdef', 'Queue')
                self.assertEqual(command.call_args_list[0].args,
                    ('api', 'repos/{owner}/{repo}/labels', '--paginate', '--slurp'))
                self.assertEqual(command.call_count, 2 if creates else 1)
                if creates:
                    self.assertEqual(command.call_args.args,
                        ('label', 'create', 'factory', '--color', 'abcdef', '--description', 'Queue'))

    def test_github_issue_list_reads_every_page_and_drops_pull_requests(self):
        pages = [[{'number': n, 'title': f'Issue {n}'} for n in range(1, 101)],
                 [{'number': 101, 'title': 'Late'}, {'number': 102, 'title': 'A PR', 'pull_request': {}}]]
        with patch.object(self.backend, 'gh', return_value=json.dumps(pages)) as command:
            issues = self.backend.issue_list('factory:queue')
        self.assertEqual([i['number'] for i in issues], list(range(1, 102)))
        command.assert_called_once_with(
            'api', 'repos/{owner}/{repo}/issues?labels=factory%3Aqueue&state=open&per_page=100',
            '--paginate', '--slurp')

    def test_github_pr_creation_preserves_body_and_returns_contract_number(self):
        with patch.object(self.backend, 'gh', return_value='https://github.com/test/repo/pull/19\n') as command:
            self.assertEqual(self.backend.pr_create('main', 'factory/work', 'Work', 'Closes #7', True),
                             {'number': 19, 'url': 'https://github.com/test/repo/pull/19'})
        command.assert_called_once_with('pr', 'create', '--base', 'main', '--head', 'factory/work',
                                        '--title', 'Work', '--body', 'Closes #7', '--draft')

    def test_github_branch_lookup_preserves_old_job_projection_and_full_cli_shape(self):
        for fields, expected in [(None, 'number,url,state'), (['number', 'url'], 'number,url')]:
            with self.subTest(fields=fields):
                with patch.object(self.backend, 'gh', return_value='[]') as command:
                    self.assertEqual(self.backend.pr_for_branch('factory/work', fields=fields), [])
                command.assert_called_once_with('pr', 'list', '--head', 'factory/work', '--state', 'open', '--json', expected)

    def test_unknown_forge_type_is_rejected_instead_of_falling_back_to_github(self):
        with self.assertRaisesRegex(self.module.Error, 'unknown forge type'):
            self.module.load({'forge': {'type': 'other'}}, REPO)


if __name__ == '__main__':
    unittest.main()
