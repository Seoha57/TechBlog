# 아직 운영 중입니다 — 작업 프로세스

## 1. 작업공간 준비

```bash
git clone https://github.com/Seoha57/TechBlog.git
cd TechBlog
```

이미 내려받은 저장소라면 최신 상태를 먼저 받습니다.

```bash
git pull origin main
```

사이트 주소는 `https://seoha57.github.io/TechBlog/`입니다. `/TechBlog`는 저장소 이름이므로 `_config.yml`의 `baseurl`과 링크에서 유지합니다.

## 2. 글 작성 전 확인

1. 주제를 QA, DBA, Infrastructure, AI 중 하나로 정합니다.
2. 최신 기술인지 확인하고 공식 문서·논문·신뢰할 수 있는 기술 블로그를 조사합니다.
3. 실제로 사용한 기술인지, 공개 자료를 바탕으로 학습하는 주제인지 구분합니다.
4. 실제 사용 경험이 없다면 “직접 실행했다”, “성능을 측정했다”라고 쓰지 않습니다.

## 3. 기술 글 필수 기준

- 본문은 최소 5,000자 이상
- 명확한 제목과 카테고리·태그 지정
- 글 초반에 초보자를 위한 기본 개념 설명
- 새 기술을 소개할 때는 해당 기술의 기반이 되는 개념·약어·문제 상황을 먼저 설명
- 독자가 해당 기술을 처음 본다고 가정하고, “무엇인지 → 왜 필요한지 → 어떻게 쓰는지” 순서로 작성
- 설명마다 가능한 경우 구체적인 예시 포함
- 초반에 `먼저 답하면` Q&A 추가
- 후반에 `한계와 적용 기준` Q&A 추가
- 기술 내용의 참고 자료와 이미지 출처를 별도로 표시
- 공식 문서·논문·신뢰 가능한 기술 블로그의 시각 자료를 우선 검토하고, 라이선스와 원문 링크를 확인한 경우에만 사용
- 외부 이미지는 저작자·원문·라이선스를 캡션에 함께 표시
- 직접 만든 도식은 외부 자료를 보완할 때만 사용하며, `이미지 출처: 직접 제작` 또는 `이미지 출처: ChatGPT 생성`으로 구분
- 같은 민트 박스·화살표 흐름도를 반복하지 않는다. 글의 질문에 맞춰 실제 화면, 코드·설정, 비교표, 타임라인, 그래프 등 서로 다른 형식을 선택한다

## 4. 파일 작성 규칙

글 파일은 `_posts` 아래에 날짜와 slug를 사용합니다.

```text
_posts/YYYY-MM-DD-topic-name.md
assets/images/topic-name-flow.svg
```

기본 Front Matter 예시:

```yaml
---
layout: post
title: "명확한 글 제목"
date: 2026-09-16 00:00:00 +0900
categories: [qa]
tags: [qa, example, technology]
---
```

설명용 도식은 기존 민트색 UI와 어울리는 SVG로 만들고, 글 안에서는 다음 구조로 넣습니다.

```html
<figure class="article-figure">
  <img src="{{ '/assets/images/topic-name-flow.svg' | relative_url }}" alt="이미지 설명">
  <figcaption>이미지 출처: ChatGPT 생성</figcaption>
</figure>
```

## 5. 글 작성 후 검토

다음 항목을 확인합니다.

- 본문 글자 수가 5,000자 이상인가?
- 제목·카테고리·태그가 명확한가?
- 기본 용어를 처음에 설명했는가?
- JSON, YAML, SQL 또는 상황 예시가 있는가?
- 장점만 말하지 않고 한계와 적용 조건을 설명했는가?
- 직접 수행하지 않은 일을 실제 경험처럼 표현하지 않았는가?
- 본문 참고 자료와 이미지 출처가 모두 있는가?
- 내부 정보·토큰·개인정보가 포함되지 않았는가?
- 글 끝에서 `글 목록 보기`와 이전·다음 글 이동이 가능한가?

## 6. 로컬 확인과 반영

변경 파일을 확인합니다.

```bash
git status
git diff --check
```

변경 사항을 커밋하고 푸시합니다.

```bash
git add _posts assets _layouts assets/css
git commit -m "Add new technical article"
git push origin main
```

GitHub Pages 배포 후 몇 분 뒤 다음 주소에서 확인합니다.

```text
https://seoha57.github.io/TechBlog/
```

글 주소는 보통 다음 형태입니다.

```text
https://seoha57.github.io/TechBlog/{category}/{slug}/
```

## 7. 현재 카테고리와 글

- QA: Playwright MCP, Contract Testing/Pact, ITSM·ITIL·ISO·CMMI
- DBA: PostgreSQL 18 AIO, PostgreSQL + pgvector
- Infrastructure: OpenTelemetry eBPF, Kubernetes Gateway API
- AI: LLM, AI 에이전트, 업무 적용과 검증

새 글을 추가할 때는 기존 글과 주제가 겹치는지 확인하고, 같은 설명을 반복하기보다 새로운 관점과 예시를 추가합니다.
