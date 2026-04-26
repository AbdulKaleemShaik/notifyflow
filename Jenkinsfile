// Jenkinsfile — Declarative CI/CD pipeline for NotifyFlow.
// Stages: Checkout → Install → Test → Build Images → Push to ECR → Deploy to EC2.

pipeline {
  agent any

  environment {
    IMAGE_TAG = "${env.BUILD_NUMBER}"
    ECR_REPO  = "${env.AWS_ACCOUNT_ID}.dkr.ecr.${env.AWS_REGION}.amazonaws.com/notifyflow"
  }

  options {
    timeout(time: 30, unit: 'MINUTES')
    disableConcurrentBuilds()
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Install & Lint') {
      parallel {
        stage('API') {
          steps { sh 'npm ci --prefix apps/api' }
        }
        stage('Worker') {
          steps { sh 'npm ci --prefix apps/worker' }
        }
        stage('WS Server') {
          steps { sh 'npm ci --prefix apps/ws-server' }
        }
        stage('Dashboard') {
          steps { sh 'npm ci --prefix apps/dashboard' }
        }
      }
    }

    stage('Test') {
      steps {
        sh 'npm test --prefix apps/api -- --coverage --ci --reporters=default --reporters=jest-junit'
        sh 'npm test --prefix apps/worker -- --ci'
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'apps/api/coverage/junit.xml'
          publishHTML(target: [
            reportName: 'API Coverage',
            reportDir: 'apps/api/coverage/lcov-report',
            reportFiles: 'index.html',
            keepAll: true,
          ])
        }
      }
    }

    stage('Build Docker Images') {
      parallel {
        stage('API image') {
          steps {
            sh 'docker build -t notifyflow-api:${IMAGE_TAG} ./apps/api'
          }
        }
        stage('Worker image') {
          steps {
            sh 'docker build -t notifyflow-worker:${IMAGE_TAG} -f apps/worker/Dockerfile .'
          }
        }
        stage('WS Server image') {
          steps {
            sh 'docker build -t notifyflow-ws:${IMAGE_TAG} ./apps/ws-server'
          }
        }
        stage('Dashboard image') {
          steps {
            sh """
              docker build \
                --build-arg VITE_API_URL=${env.PROD_API_URL ?: 'http://localhost:3000'} \
                --build-arg VITE_WS_HOST=${env.PROD_WS_HOST ?: 'localhost'} \
                -t notifyflow-dashboard:${IMAGE_TAG} \
                ./apps/dashboard
            """
          }
        }
      }
    }

    stage('Push to ECR') {
      when { branch 'main' }
      steps {
        sh 'aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REPO}'

        sh 'docker tag notifyflow-api:${IMAGE_TAG} ${ECR_REPO}/api:${IMAGE_TAG}'
        sh 'docker push ${ECR_REPO}/api:${IMAGE_TAG}'
        sh 'docker tag notifyflow-api:${IMAGE_TAG} ${ECR_REPO}/api:latest'
        sh 'docker push ${ECR_REPO}/api:latest'

        sh 'docker tag notifyflow-worker:${IMAGE_TAG} ${ECR_REPO}/worker:${IMAGE_TAG}'
        sh 'docker push ${ECR_REPO}/worker:${IMAGE_TAG}'
        sh 'docker tag notifyflow-worker:${IMAGE_TAG} ${ECR_REPO}/worker:latest'
        sh 'docker push ${ECR_REPO}/worker:latest'

        sh 'docker tag notifyflow-ws:${IMAGE_TAG} ${ECR_REPO}/ws-server:${IMAGE_TAG}'
        sh 'docker push ${ECR_REPO}/ws-server:${IMAGE_TAG}'
        sh 'docker tag notifyflow-ws:${IMAGE_TAG} ${ECR_REPO}/ws-server:latest'
        sh 'docker push ${ECR_REPO}/ws-server:latest'

        sh 'docker tag notifyflow-dashboard:${IMAGE_TAG} ${ECR_REPO}/dashboard:${IMAGE_TAG}'
        sh 'docker push ${ECR_REPO}/dashboard:${IMAGE_TAG}'
        sh 'docker tag notifyflow-dashboard:${IMAGE_TAG} ${ECR_REPO}/dashboard:latest'
        sh 'docker push ${ECR_REPO}/dashboard:latest'
      }
    }

    stage('Deploy to EC2') {
      when { branch 'main' }
      steps {
        sshPublisher(publishers: [
          sshPublisherDesc(
            configName: 'notifyflow-prod',
            transfers: [sshTransfer(
              execCommand: """
                docker pull ${ECR_REPO}/api:${IMAGE_TAG}
                docker pull ${ECR_REPO}/worker:${IMAGE_TAG}
                docker pull ${ECR_REPO}/ws-server:${IMAGE_TAG}
                docker pull ${ECR_REPO}/dashboard:${IMAGE_TAG}

                IMAGE_TAG=${IMAGE_TAG} docker-compose \\
                  -f docker-compose.yml \\
                  -f docker-compose.prod.yml \\
                  up -d --no-deps \\
                  api worker ws-server dashboard

                docker image prune -f
              """
            )]
          )
        ])
      }
    }
  }

  post {
    failure {
      echo 'Build failed — notify team via Slack/email'
    }
    success {
      echo "Build #${env.BUILD_NUMBER} deployed successfully"
    }
    always {
      // Clean up local Docker images to prevent disk bloat on the Jenkins agent.
      sh 'docker rmi notifyflow-api:${IMAGE_TAG} notifyflow-worker:${IMAGE_TAG} notifyflow-ws:${IMAGE_TAG} notifyflow-dashboard:${IMAGE_TAG} || true'
    }
  }
}
