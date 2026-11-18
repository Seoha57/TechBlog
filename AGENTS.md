# TechBlog 작업 지침

이 문서는 `TechBlog` 저장소에서 글·사이트 변경을 수행하는 모든 Codex 세션의 공통 작업 기준이다. 기존 [`BLOG_WORKFLOW.md`](BLOG_WORKFLOW.md)는 배경 안내용으로 유지하되, 글 분량과 배포 완료 기준이 충돌하면 이 문서를 우선한다.

## 저장소와 사이트

- 기본 브랜치: `main`
- 원격: `origin` (`Seoha57/TechBlog`)
- 게시 주소: `https://seoha57.github.io/TechBlog/`
- Jekyll 게시글: `_posts/YYYY-MM-DD-slug.md`
- URL 규칙: `https://seoha57.github.io/TechBlog/{category}/{slug}/`
- 설정: `_config.yml`의 `baseurl: /TechBlog`를 바꾸지 않는다.

작업 전에는 `git status --short`와 최근 `_posts`를 확인한다. 다른 사람이 남긴 변경은 사용자 소유로 간주하며 되돌리거나 덮어쓰지 않는다.

## 일일 글 작성 기준

매일 작업 시 독립된 한국어 기술 글 두 편을 작성한다. 최근 작성 이력을 보고 `QA → DBA → Infrastructure → AI`가 장기적으로 고르게 순환되도록 고른다. DBA는 Oracle, Tibero, MySQL/MariaDB, PostgreSQL 및 SQL·설계·성능·운영 주제를 특정 제품에 치우치지 않게 순환한다.

각 글은 다음을 모두 만족해야 한다.

- 기존 글과 제목·핵심 내용이 중복되지 않는 신규 주제
- `title`, `categories`, `tags`, `description` Front Matter
- 본문 한국어 글자 수가 **8,000자 이상**. Front Matter를 제외한 본문에서 `[가-힣]` 글자 수를 계산한다.
- 시작 부분의 `## 먼저 답하기` Q&A
- `## 먼저 알아둘 기반 기술`
- `## 한계와 적용 기준 Q&A`
- 구체적인 업무 예시, 코드 또는 명령어 예시(코드 블록 사용), 신뢰할 수 있는 출처 링크
- 참고 자료 제목은 정확히 `<h3 class="references-heading">참고 자료</h3>`

독자는 취업 준비생과 해당 기술을 처음 접하는 현업자다. 약어·제품명·프로토콜·프레임워크는 첫 등장 시 풀네임과 쉬운 정의를 쓴다. 무엇인지, 왜 등장했는지, 기존 방식과 차이, 구성 요소와 동작, 사용할 때와 피할 때를 설명한다.

직접 수행하지 않은 운영 경험·성능 측정·장애 대응을 한 것처럼 쓰지 않는다. 외부 이미지는 원 출처와 라이선스 또는 사용 조건을 캡션에 표기한다. 꼭 필요하지 않으면 이미지를 추가하지 않으며, 직접 도식은 `이미지 출처: 직접 제작`으로 표기한다.

## 작성·검증 순서

1. 최근 글·제목·핵심 키워드를 검색해 주제 중복을 피한다.
2. 공식 문서, 표준, 논문 등 신뢰할 수 있는 원문을 조사한다.
3. 두 초안을 실제 `_posts` 파일로 작성한다.
4. 두 글 모두 8,000자 이상이 될 때까지 설명·예시·적용 기준을 자연스럽게 보완한다. 분량 미달 상태로 커밋하지 않는다.
5. Front Matter, 필수 섹션, 참고 자료 헤딩, 링크, 이미지 캡션을 확인한다.
6. 모든 외부 참고 링크의 HTTP 상태를 확인하고, 실패 링크는 교체하거나 제거한다.
7. `git diff --check`를 통과시킨다. Markdown 공백 오류, SVG/XML 변경, 링크를 함께 점검한다.

본문 글자 수 확인 예시:

```powershell
$t = Get-Content -Raw _posts/YYYY-MM-DD-slug.md
$body = ($t -split '(?m)^---\r?$')[2]
[regex]::Matches($body, '[가-힣]').Count
```

## 커밋과 배포 완료 기준

초안 저장이나 `git push`만으로 작업을 완료로 보고하지 않는다. 다음이 모두 성공해야 완료다.

1. `git diff --check` 및 스테이징된 변경의 `git diff --cached --check` 통과
2. `main`에 커밋하고 `git push origin main` 성공
3. 해당 **전체 커밋 SHA**의 GitHub Pages Actions 워크플로가 `completed/success`
4. 두 새 글의 정확한 라이브 URL을 직접 요청해 HTTP 200 확인

Pages 확인 예시:

```powershell
$sha = git rev-parse HEAD
$headers = @{ 'User-Agent' = 'Codex' }
$runs = Invoke-RestMethod -Uri 'https://api.github.com/repos/Seoha57/TechBlog/actions/runs?per_page=50' -Headers $headers
$runs.workflow_runs | Where-Object { $_.head_sha -eq $sha } | Select-Object -First 1 status, conclusion, html_url
```

라이브 URL 확인 예시:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'https://seoha57.github.io/TechBlog/{category}/{slug}/'
```

분량, 링크, 마크다운, 빌드, 배포 검증에서 오류가 나면 가능한 범위에서 수정하고 해당 검증부터 다시 수행한다. 저장소 접근·푸시 권한·GitHub Pages 자체 장애처럼 스스로 고칠 수 없는 외부 문제일 때만 실패를 보고한다.

## 완료 보고 형식

완료 후에는 각 글의 카테고리, 제목, 한 줄 핵심 주제, 라이브 URL, 전체 커밋 SHA, Pages 성공 및 HTTP 200 확인 사실을 짧게 남긴다. 아직 모든 기준을 통과하지 못했다면 완료 보고를 남기지 말고 작업을 계속한다.

## 세션 인수인계

새 세션은 이 파일과 최근 Git 로그·`_posts`를 먼저 읽어 작업을 이어간다. 대화의 임시 판단보다 저장소의 파일·커밋·배포 검증 결과를 우선 사실로 사용한다. 일일 카테고리 순서는 고정 날짜표가 아니라 최근 커밋된 게시글을 기준으로 다시 계산한다.
