# 아직 운영 중입니다 — 작업 프로세스

이 문서는 사람이 블로그 작업 흐름을 빠르게 파악하기 위한 요약이다. 세부 기준(분량, 시각 자료, 기반 기술 섹션, 주제 중복 금지, 검증·배포 완료 기준)은 [`AGENTS.md`](AGENTS.md)가 유일한 기준이며, 두 문서가 다르면 `AGENTS.md`를 따른다.

## 1. 작업공간 준비

```bash
git clone https://github.com/Seoha57/TechBlog.git
cd TechBlog
git pull --ff-only origin main
git status --short
```

- 사이트: `https://seoha57.github.io/TechBlog/`
- 글 주소: `https://seoha57.github.io/TechBlog/{category}/{slug}/`
- `_config.yml`의 `baseurl: /TechBlog`는 바꾸지 않는다.

## 2. 일일 작업 요약

매일 오전 8시(KST) Claude Code 클라우드 루틴이 `AGENTS.md`를 읽고 다음을 수행한다. 사람이 직접 쓸 때도 같은 순서를 따른다.

1. `_posts` 전체와 대조해 주제 중복이 없는 새 주제 두 개를 고른다. 카테고리는 최근 글 기준으로 `QA → DBA → Infrastructure → AI`를 순환한다.
2. 공식 문서·표준·논문 등 신뢰할 수 있는 원문을 조사한다.
3. `_posts/YYYY-MM-DD-slug.md`로 두 글을 작성한다.
4. 분량·필수 섹션·시각 자료·링크·Liquid 문법을 검증하고, 로컬 Jekyll 빌드를 통과시킨다.
5. `main`에 커밋·푸시하고, GitHub Pages 배포 성공과 라이브 URL HTTP 200을 확인한다.

## 3. 글 기준 한눈에 보기

| 항목 | 기준 |
| --- | --- |
| 분량 | Front Matter 제외 본문 한글 8,000자 이상(미달이면 커밋 금지) |
| Front Matter | `title`, `categories`, `tags`, `description` |
| 필수 섹션 | `## 먼저 답하기`, `## 먼저 알아둘 기반 기술`, `## 한계와 적용 기준 Q&A`, 참고 자료 헤딩 |
| 기반 기술 | 본문에서 쓰이는 사전 개념을 빠짐없이, 소절 4개 이상, 본문 절과 연결하는 지도 표 |
| 시각·실습 자료 | 그림 1개 이상, 코드 블록 4개 이상, 비교 표 1개 이상, 참고 자료 5개 이상 |
| 이미지 | 직접 제작 SVG(`이미지 출처: 직접 제작`) 또는 라이선스 확인된 원본(출처·라이선스 캡션) |
| 서술 | 직접 하지 않은 운영·측정·장애 대응을 경험처럼 쓰지 않는다 |
| 독자 | 취업 준비생과 해당 기술을 처음 접하는 현업자. 약어는 첫 등장 시 풀네임과 쉬운 정의 |

## 4. 파일 구조

```text
_posts/YYYY-MM-DD-topic-name.md
assets/images/topic-name-flow.svg
assets/images/sources/      # 라이선스가 확인된 외부 이미지
```

Front Matter 예시:

```yaml
---
layout: post
title: "명확한 글 제목"
date: 2026-09-16 00:00:00 +0900
categories: [qa]
tags: [qa, example, technology]
description: "한 줄 요약"
---
```

그림은 `<figure class="article-figure">` 안에 `img`와 `figcaption`을 넣는 기존 글의 형식을 그대로 따른다. 이미지 경로는 `relative_url` 필터를 쓴다(기존 글 참고).

## 5. Jekyll·Liquid 주의

Jekyll은 본문의 이중 중괄호와 중괄호+퍼센트 문법을 Liquid로 해석한다. Ansible·Jinja2·Helm·Go 템플릿처럼 같은 문법을 쓰는 예시는 Liquid `raw`/`endraw` 태그로 감싼다. GitHub Pages는 루트의 `.md` 문서(이 파일, `AGENTS.md` 포함)도 렌더링하므로 이런 문서에 해당 문법을 그대로 적지 않는다.

## 6. 반영과 확인

```bash
git diff --check
git add _posts assets
git diff --cached --check
git commit -m "docs: add <topic1> and <topic2> guides"
git push origin main
```

푸시만으로 끝내지 않는다. 해당 커밋의 Pages Actions 실행이 `completed/success`인지, 새 글 라이브 URL이 HTTP 200인지 확인한다(명령 예시는 `AGENTS.md`).
