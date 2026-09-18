# syntax=docker/dockerfile:1.7

FROM nginx:1.31-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
