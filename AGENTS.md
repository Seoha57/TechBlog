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

- 기존 글과 제목·핵심 내용이 중복되지 않는 신규 주제 (아래 "주제 중복 금지" 규칙 필수)
- `title`, `categories`, `tags`, `description` Front Matter
- 본문 한국어 글자 수가 **8,000자 이상**. Front Matter를 제외한 본문에서 `[가-힣]` 글자 수를 계산한다. 바이트가 아니라 글자 수로 센다(아래 예시 또는 python `len(re.findall('[가-힣]', body))`). **한 편이라도 8,000자 미만이면 예외 없이 커밋·푸시하지 않고**, 내용을 보완해 다시 측정하는 과정을 기준을 넘을 때까지 반복한다. 완료 보고에 각 글의 글자 수를 적는다.
- 시각·실습 자료를 풍부하게 넣는다. 각 글마다 최소 기준:
  - 그림 1개 이상: 개념 구조·동작 흐름을 보여주는 직접 제작 SVG 도식(`assets/images/`에 저장, 캡션 `이미지 출처: 직접 제작`) 또는 라이선스가 확인된 공식 이미지(`assets/images/sources/`에 저장, 캡션에 원 출처 링크와 라이선스). 기존 글처럼 `<figure class="article-figure"><img src="{{ '/assets/images/...' | relative_url }}" alt="..."><figcaption>...</figcaption></figure>` 형식을 쓴다.
  - 코드 블록 4개 이상: SQL 쿼리, 명령어, 설정 파일, 스크립트, 실행 결과 예시 등을 본문 흐름에 맞게 자주 넣는다. DBA 글은 실제로 돌려볼 수 있는 조회·진단 쿼리를 중심으로 넣는다.
  - 비교 표 1개 이상(기존 방식과 차이, 선택 기준 등).
  - 신뢰할 수 있는 참고 자료 5개 이상(공식 문서, 표준, 논문, 공식 블로그).
- 시작 부분의 `## 먼저 답하기` Q&A
- `## 먼저 알아둘 기반 기술`
- `## 한계와 적용 기준 Q&A`
- 구체적인 업무 예시, 코드 또는 명령어 예시(코드 블록 사용), 신뢰할 수 있는 출처 링크
- 참고 자료 제목은 정확히 `<h3 class="references-heading">참고 자료</h3>`

독자는 취업 준비생과 해당 기술을 처음 접하는 현업자다. 약어·제품명·프로토콜·프레임워크는 첫 등장 시 풀네임과 쉬운 정의를 쓴다. 무엇인지, 왜 등장했는지, 기존 방식과 차이, 구성 요소와 동작, 사용할 때와 피할 때를 설명한다.

직접 수행하지 않은 운영 경험·성능 측정·장애 대응을 한 것처럼 쓰지 않는다. 외부 이미지는 원 출처와 라이선스 또는 사용 조건을 캡션에 표기하고, 라이선스를 확인할 수 없는 이미지는 쓰지 않고 직접 도식으로 대신한다. 직접 도식은 `이미지 출처: 직접 제작`으로 표기한다. SVG는 XML로 올바른지 확인한다.

## 주제 중복 금지 (절대 규칙)

지금까지 게시한 어떤 글과도 주제가 겹치면 안 된다. 주제를 정하기 전에 다음을 반드시 수행한다.

- 최근 글만이 아니라 `_posts` 전체 파일의 파일명(slug)·`title`·`tags`·`description`을 모두 뽑아 대조한다.
- 후보 주제마다 핵심 기술·키워드를 영문·한글 표기 모두로 `_posts` 전체에서 검색한다. 같은 기술을 핵심으로 다룬 글이 하나라도 있으면 그 후보는 버린다.
- 각도만 바꾼 재탕(같은 기능의 "운영편", "심화편", "실전편" 등)도 중복으로 본다.
- 겹치지 않음이 확인된 주제만 작성하고, 완료 보고에 어떤 키워드로 검색해 중복 없음을 확인했는지 한 줄 남긴다.

중복 확인 예시:

```powershell
Get-ChildItem _posts/*.md | ForEach-Object {
  $fm = ((Get-Content -Raw -Encoding utf8 $_.FullName) -split '(?m)^---\r?$')[1]
  "$($_.BaseName) | " + (($fm -split "`n" | Where-Object { $_ -match '^(title|tags):' }) -join ' ')
}
Select-String -Encoding utf8 -Path _posts/*.md -Pattern 'keyword|키워드' -List | Select-Object Path
```

## 작성·검증 순서

1. 위 "주제 중복 금지" 규칙에 따라 `_posts` 전체와 대조해 겹치지 않는 주제를 고른다.
2. 공식 문서, 표준, 논문 등 신뢰할 수 있는 원문을 조사한다.
3. 두 초안을 실제 `_posts` 파일로 작성한다.
4. 두 글 모두 8,000자 이상이 될 때까지 설명·예시·적용 기준을 자연스럽게 보완한다. 분량 미달 상태로 커밋하지 않는다.
5. Front Matter, 필수 섹션, 참고 자료 헤딩, 링크, 이미지 캡션, 시각·실습 자료 최소 기준(그림·코드 블록·표·참고 자료 수)을 확인한다. 이미지 파일 경로가 실제로 존재하는지도 확인한다.
6. 모든 외부 참고 링크의 HTTP 상태를 확인하고, 실패 링크는 교체하거나 제거한다.
7. `git diff --check`를 통과시킨다. Markdown 공백 오류, SVG/XML 변경, 링크를 함께 점검한다.
8. Liquid 충돌을 막는다. Jekyll은 본문의 이중 중괄호 출력 태그와 중괄호+퍼센트 블록 태그를 Liquid로 해석하므로, Ansible·Jinja2·Helm·Go 템플릿처럼 이 문법을 쓰는 코드 블록이나 인라인 코드는 반드시 Liquid `raw` 태그와 `endraw` 태그 사이에 넣는다(예: `_posts/2026-11-21-ansible-idempotent-configuration-management.md`). 단, `relative_url` 같은 이미지 경로용 Liquid는 raw 구간 밖에 둔다. 커밋 전 `Select-String -Encoding utf8 -Path _posts/<새 글>.md -Pattern '\{\{|\{%'`로 해당 문법 위치를 모두 확인한다. 이 AGENTS.md도 GitHub Pages가 렌더링하므로 여기에 Liquid 태그를 그대로 적지 않는다.

본문 글자 수 확인 예시:

```powershell
$t = Get-Content -Raw -Encoding utf8 _posts/YYYY-MM-DD-slug.md
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

완료 후에는 각 글의 카테고리, 제목, 한 줄 핵심 주제, 본문 글자 수, 그림·코드 블록 수, 라이브 URL, 전체 커밋 SHA, Pages 성공 및 HTTP 200 확인 사실을 짧게 남긴다. 아직 모든 기준을 통과하지 못했다면 완료 보고를 남기지 말고 작업을 계속한다.

## 세션 인수인계

새 세션은 이 파일과 최근 Git 로그·`_posts`를 먼저 읽어 작업을 이어간다. 대화의 임시 판단보다 저장소의 파일·커밋·배포 검증 결과를 우선 사실로 사용한다. 일일 카테고리 순서는 고정 날짜표가 아니라 최근 커밋된 게시글을 기준으로 다시 계산한다.
