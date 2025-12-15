# n8n 설정

## 설치 방법

### 1. Docker로 실행 (권장)
```bash
cd n8n
docker-compose up -d
```

### 2. npm으로 실행 (Docker 없이)
```bash
npm install -g n8n
n8n start
```

## 접속
- URL: http://localhost:5678

## 설정

### AUTH_TOKEN 설정
1. pojangboss 어드민 로그인
2. F12 > Application > Local Storage > token 복사
3. docker-compose.yml의 AUTH_TOKEN에 붙여넣기
4. `docker-compose down && docker-compose up -d`

### GRAPHQL_URL 설정
- 로컬: `http://host.docker.internal:8080/graphql/`
- 스테이지: `https://stage-api.pojangboss.com/graphql/`
- 프로덕션: `https://api.pojangboss.com/graphql/`

## 워크플로우 Import
1. n8n 접속 (localhost:5678)
2. 좌측 메뉴 > Import from file
3. `workflows/` 폴더의 JSON 파일 선택
