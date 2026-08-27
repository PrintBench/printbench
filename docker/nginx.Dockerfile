# syntax=docker/dockerfile:1.7

FROM nginx:1.29-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
